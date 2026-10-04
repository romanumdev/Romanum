-- Public MCP tool outcomes only. No arguments, responses, identities or billing records.
CREATE TABLE mcp_tool_usage_daily (
  day date NOT NULL,
  tool_name text NOT NULL CHECK (tool_name ~ '^[a-z_]{1,64}$'),
  successful_calls bigint NOT NULL DEFAULT 0 CHECK (successful_calls >= 0),
  failed_calls bigint NOT NULL DEFAULT 0 CHECK (failed_calls >= 0),
  PRIMARY KEY (day, tool_name)
);
