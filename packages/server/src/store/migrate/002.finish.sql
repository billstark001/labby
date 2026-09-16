ALTER TABLE keyword_vectors
  ALTER COLUMN embedding SET NOT NULL,
  ALTER COLUMN geometry SET NOT NULL,
  DROP COLUMN vector64,
  DROP COLUMN projection2d;
ALTER TABLE keyword_vectors ADD CONSTRAINT embedding_shape CHECK (
  jsonb_typeof(embedding) = 'array'
  AND jsonb_array_length(embedding) =
    (geometry->>'hyperbolicDimensions')::int + (geometry->>'euclideanDimensions')::int
);
CREATE TABLE ranking_judgments (id text PRIMARY KEY, payload jsonb NOT NULL);
