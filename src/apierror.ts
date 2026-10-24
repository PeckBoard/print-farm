// An error with an HTTP status and extra body fields for the page API
// (`{"error", "field"}` on validation, `{"error": "exists"}` on a name clash).
// MCP tools see the same body as their result. Pure.

export class ApiError extends Error {
  constructor(
    public status: number,
    msg: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(msg);
  }
}

/// 400 naming the offending field.
export function fieldError(field: string, msg: string): ApiError {
  return new ApiError(400, msg, { field });
}
