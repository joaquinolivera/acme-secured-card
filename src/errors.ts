export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const notFound = (what = 'resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const invalidState = (msg: string) => new AppError(409, 'INVALID_STATE', msg);
