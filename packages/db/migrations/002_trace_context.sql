-- W3C traceparent of the API request that published the event, so delivery
-- attempts can join the same distributed trace. Null when tracing is disabled.
ALTER TABLE events ADD COLUMN trace_parent text
  CHECK (trace_parent IS NULL OR trace_parent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');
