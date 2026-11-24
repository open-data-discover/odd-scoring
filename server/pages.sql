CREATE TABLE IF NOT EXISTS odd_scoring.catalog_columns (
  sha text NOT NULL,
  id integer NOT NULL,
  analyzed_at text NOT NULL,
  details jsonb NOT NULL,
  PRIMARY KEY (sha, id)
);

CREATE TABLE IF NOT EXISTS odd_scoring.catalog_pairs (
  sha text NOT NULL,
  pool text NOT NULL CHECK (pool IN ('detected', 'random')),
  ordinal integer NOT NULL,
  a integer NOT NULL,
  b integer NOT NULL,
  score double precision,
  PRIMARY KEY (sha, pool, ordinal),
  FOREIGN KEY (sha, a) REFERENCES odd_scoring.catalog_columns(sha, id),
  FOREIGN KEY (sha, b) REFERENCES odd_scoring.catalog_columns(sha, id)
);

CREATE OR REPLACE FUNCTION odd_scoring.notify_leaderboard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM realtime.send('{}'::jsonb, 'changed', 'odd-scoring-leaderboard', false);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- A notification failure must not roll back a saved vote.
  RAISE WARNING 'Join Check leaderboard notification failed (%).', SQLSTATE;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION odd_scoring.notify_leaderboard() FROM PUBLIC;
CREATE OR REPLACE TRIGGER review_points_notify_leaderboard
  AFTER INSERT ON odd_scoring.review_points
  FOR EACH ROW EXECUTE FUNCTION odd_scoring.notify_leaderboard();
DROP INDEX IF EXISTS odd_scoring.review_points_by_cutoff;

CREATE OR REPLACE FUNCTION odd_scoring.review_receipt(
  player_id integer, source_sha text, pool_name text, pair_number integer, receipt_key bytea
) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT encode(extensions.hmac(convert_to(format('[%s,%s,%s,%s]', player_id,
    to_json(source_sha), to_json(pool_name), pair_number), 'UTF8'), receipt_key, 'sha256'), 'hex');
$$;
REVOKE ALL ON FUNCTION odd_scoring.review_receipt(integer, text, text, integer, bytea) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.odd_scoring_play(
  action text, session_token text DEFAULT NULL, payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  player_id integer;
  player_name text;
  review_key text;
  receipt_key bytea;
  new_token text;
  current_ms bigint := floor(extract(epoch FROM statement_timestamp()) * 1000);
  ranked jsonb;
  own_rank jsonb;
  total integer;
  snapshot_sha text;
  pool_name text;
  pair_number integer;
  pool_size integer;
  start_ordinal integer;
  pair odd_scoring.catalog_pairs%ROWTYPE;
  columns jsonb;
  card jsonb;
  receipt text;
  saved boolean;
  voted_yes boolean;
  predicted boolean;
  prior smallint;
  current_rank integer;
  tied_players integer;
  promotion integer;
BEGIN
  IF session_token ~ '^[0-9a-f]{64}$' THEN
    SELECT p.id, p.name INTO player_id, player_name
    FROM odd_scoring.sessions AS s JOIN odd_scoring.players AS p ON p.id = s.player
    WHERE s.hash = encode(extensions.digest(convert_to(session_token, 'UTF8'), 'sha256'), 'hex')
      AND s.expires_at > current_ms;
  END IF;

  IF action = 'select' THEN
    IF jsonb_typeof(payload->'name') IS DISTINCT FROM 'string' OR length(payload->>'name') > 100 THEN
      RAISE SQLSTATE 'PT400' USING MESSAGE = 'Enter a username.';
    END IF;
    player_name := normalize(btrim(payload->>'name'), NFC);
    IF player_name !~ '^[[:alnum:]][[:alnum:] _-]{0,23}$' THEN
      RAISE SQLSTATE 'PT400' USING MESSAGE =
        'Use 1–24 letters, numbers, spaces, hyphens or underscores, starting with a letter or number.';
    END IF;
    INSERT INTO odd_scoring.players AS p (name, name_key) VALUES (player_name, lower(player_name))
    ON CONFLICT (name_key) DO NOTHING RETURNING p.id INTO player_id;
    IF player_id IS NULL THEN
      IF payload->'joinExisting' IS DISTINCT FROM 'true'::jsonb THEN
        RAISE SQLSTATE 'PT409' USING MESSAGE = 'This username is already taken.';
      END IF;
      SELECT p.id, p.name INTO player_id, player_name
      FROM odd_scoring.players AS p WHERE p.name_key = lower(player_name);
    END IF;
    new_token := encode(extensions.gen_random_bytes(32), 'hex');
    DELETE FROM odd_scoring.sessions WHERE expires_at <= current_ms;
    INSERT INTO odd_scoring.sessions VALUES (
      encode(extensions.digest(convert_to(new_token, 'UTF8'), 'sha256'), 'hex'),
      player_id, current_ms + 31536000000
    );
  END IF;

  IF action IN ('session', 'select') THEN
    IF player_id IS NULL THEN RETURN 'null'::jsonb; END IF;
    SELECT count(*) INTO total FROM odd_scoring.review_points WHERE player = player_id;
    RETURN jsonb_strip_nulls(jsonb_build_object('name', player_name, 'points', total, 'token', new_token));
  END IF;
  IF action = 'leaderboard' THEN
    WITH totals AS (
      SELECT player, count(*) AS points FROM odd_scoring.review_points
      GROUP BY player
    ), ranks AS (
      SELECT p.id, p.name, t.points, rank() OVER (ORDER BY t.points DESC) AS rank,
        row_number() OVER (ORDER BY t.points DESC, p.name_key) AS position
      FROM totals AS t JOIN odd_scoring.players AS p ON p.id = t.player
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object('name', name, 'rank', rank, 'points', points)
      ORDER BY position) FILTER (WHERE position <= 50), '[]'::jsonb),
      (jsonb_agg(jsonb_build_object('rank', rank, 'points', points)) FILTER (WHERE id = player_id))->0
    INTO ranked, own_rank FROM ranks;
    RETURN jsonb_build_object('asOf', statement_timestamp(), 'top', ranked, 'you',
      CASE WHEN player_id IS NULL THEN NULL ELSE jsonb_build_object('name', player_name,
        'livePoints', coalesce(own_rank->'points','0'::jsonb),
        'rank', own_rank->'rank', 'points', coalesce(own_rank->'points','0'::jsonb)) END);
  END IF;

  IF player_id IS NULL THEN
    RAISE SQLSTATE 'PT401' USING MESSAGE = 'Choose a username to continue.';
  END IF;
  SELECT decrypted_secret INTO STRICT review_key
  FROM vault.decrypted_secrets WHERE name = 'odd_scoring_card_key';
  receipt_key := extensions.hmac(convert_to('join-check/receipt/v1', 'UTF8'), decode(review_key, 'hex'), 'sha256');

  IF action = 'card' THEN
    SELECT c.sha INTO snapshot_sha FROM odd_scoring.catalog_columns AS c
    WHERE c.id = 0 ORDER BY c.analyzed_at DESC, c.sha DESC LIMIT 1;
    pool_name := CASE WHEN random() < 0.75 THEN 'detected' ELSE 'random' END;
    FOR attempt IN 1..2 LOOP
      SELECT max(p.ordinal) + 1 INTO pool_size FROM odd_scoring.catalog_pairs AS p
      WHERE p.sha = snapshot_sha AND p.pool = pool_name;
      FOR draw IN 1..12 LOOP
        pair_number := floor(random() * pool_size);
        EXIT WHEN NOT EXISTS (SELECT 1 FROM odd_scoring.review_points
          WHERE player = player_id AND review_points.receipt =
            odd_scoring.review_receipt(player_id, snapshot_sha, pool_name, pair_number, receipt_key));
        pair_number := NULL;
      END LOOP;
      IF pair_number IS NULL AND pool_size > 0 THEN
        start_ordinal := floor(random() * pool_size);
        SELECT n INTO pair_number FROM generate_series(0, pool_size - 1) AS offset_no
        CROSS JOIN LATERAL (SELECT (start_ordinal + offset_no) % pool_size AS n) AS candidate
        WHERE NOT EXISTS (SELECT 1 FROM odd_scoring.review_points
          WHERE player = player_id AND review_points.receipt =
            odd_scoring.review_receipt(player_id, snapshot_sha, pool_name, n, receipt_key))
        LIMIT 1;
      END IF;
      EXIT WHEN pair_number IS NOT NULL;
      pool_name := CASE WHEN pool_name = 'detected' THEN 'random' ELSE 'detected' END;
    END LOOP;
    IF pair_number IS NULL THEN RETURN 'null'::jsonb; END IF;
    SELECT * INTO STRICT pair FROM odd_scoring.catalog_pairs AS p
    WHERE p.sha = snapshot_sha AND p.pool = pool_name AND p.ordinal = pair_number;
    SELECT jsonb_agg(c.details - 'resource_id' - 'package' - 'column_id' ORDER BY c.id)
    INTO columns FROM odd_scoring.catalog_columns AS c WHERE c.sha = snapshot_sha AND c.id IN (pair.a, pair.b);
    IF random() < 0.5 THEN columns := jsonb_build_array(columns->1, columns->0); END IF;
    RETURN jsonb_build_object('columns', columns, 'id', replace(encode(extensions.pgp_sym_encrypt(
      jsonb_build_object('player', player_id, 'sha', snapshot_sha, 'pool', pool_name, 'ordinal', pair_number)::text,
      review_key, 'cipher-algo=aes256, s2k-mode=1'), 'base64'), chr(10), ''));
  END IF;

  IF action = 'answer' THEN
    IF jsonb_typeof(payload->'answer') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(payload->'cardId') IS DISTINCT FROM 'string'
       OR length(payload->>'cardId') > 512 THEN
      RAISE SQLSTATE 'PT400' USING MESSAGE = 'Choose yes or no for the current card.';
    END IF;
    BEGIN
      card := extensions.pgp_sym_decrypt(decode(payload->>'cardId', 'base64'), review_key)::jsonb;
    EXCEPTION WHEN OTHERS THEN
      RAISE SQLSTATE 'PT404' USING MESSAGE = 'This card is unavailable. Reload to get a new card.';
    END;
    IF (card->>'player')::integer IS DISTINCT FROM player_id THEN
      RAISE SQLSTATE 'PT404' USING MESSAGE = 'This card is unavailable. Reload to get a new card.';
    END IF;
    snapshot_sha := card->>'sha';
    pool_name := card->>'pool';
    pair_number := (card->>'ordinal')::integer;
    predicted := pool_name = 'detected';
    voted_yes := (payload->>'answer')::boolean;
    receipt := odd_scoring.review_receipt(player_id, snapshot_sha, pool_name, pair_number, receipt_key);
    PERFORM 1 FROM odd_scoring.players AS p WHERE p.id = player_id FOR UPDATE;
    INSERT INTO odd_scoring.review_points VALUES (player_id, receipt, current_ms) ON CONFLICT DO NOTHING;
    saved := FOUND;
    IF saved AND voted_yes <> predicted THEN
      INSERT INTO odd_scoring.disagreements
      SELECT player_id, receipt, snapshot_sha, l.analyzed_at, pool_name, p.score,
        jsonb_build_object('id',l.id,'dataset',l.details->'package','title',l.details->'dataset',
          'file',l.details->'file','resource',l.details->'resource','resource_id',l.details->'resource_id','name',l.details->'name'),
        jsonb_build_object('id',r.id,'dataset',r.details->'package','title',r.details->'dataset',
          'file',r.details->'file','resource',r.details->'resource','resource_id',r.details->'resource_id','name',r.details->'name'),
        voted_yes::integer
      FROM odd_scoring.catalog_pairs AS p
      JOIN odd_scoring.catalog_columns AS l ON l.sha = p.sha AND l.id = p.a
      JOIN odd_scoring.catalog_columns AS r ON r.sha = p.sha AND r.id = p.b
      WHERE p.sha = snapshot_sha AND p.pool = pool_name AND p.ordinal = pair_number;
      IF NOT FOUND THEN RAISE SQLSTATE 'PT404' USING MESSAGE = 'This pair is no longer available.'; END IF;
    ELSIF NOT saved THEN
      SELECT d.answer INTO prior FROM odd_scoring.disagreements AS d
      WHERE d.player = player_id AND d.receipt = odd_scoring.review_receipt(
        player_id, snapshot_sha, pool_name, pair_number, receipt_key);
      voted_yes := coalesce(prior = 1, predicted);
    END IF;
    SELECT count(*) INTO total FROM odd_scoring.review_points WHERE player = player_id;
    IF saved THEN
      SELECT 1 + count(*) FILTER (WHERE points > total), count(*) FILTER (WHERE points = total)
      INTO current_rank, tied_players
      FROM (SELECT count(*) AS points FROM odd_scoring.review_points
        WHERE player <> player_id GROUP BY player) AS others;
      IF current_rank <= 10 AND (total = 1 OR tied_players > 0) THEN
        promotion := current_rank;
      END IF;
    END IF;
    RETURN jsonb_build_object('answer', voted_yes, 'points', total, 'promotion', promotion);
  END IF;

  RAISE SQLSTATE 'PT404' USING MESSAGE = 'This action is unavailable.';
END;
$$;

REVOKE ALL ON FUNCTION public.odd_scoring_play(text, text, jsonb) FROM PUBLIC, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.odd_scoring_play(text, text, jsonb) TO anon;
