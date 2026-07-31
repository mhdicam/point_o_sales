/**
 * HTTP error contract.
 *
 * One error shape for the whole API so the POS client can branch on `code`
 * rather than parsing prose. `code` is stable and machine-readable; `message` is
 * for humans and may change.
 *
 * Auth and permission failures deliberately carry no detail about *why* — see
 * the note on 401 below.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new HttpError(400, code, message, details)

/**
 * 401 — deliberately vague.
 *
 * "Email not found" vs "wrong password" tells an attacker which half to keep
 * trying, and turns the login endpoint into an account-enumeration oracle.
 */
export const unauthorized = (message = 'Invalid credentials') =>
  new HttpError(401, 'UNAUTHORIZED', message)

export const forbidden = (code: string, message: string, details?: unknown) =>
  new HttpError(403, code, message, details)

export const notFound = (code: string, message: string) => new HttpError(404, code, message)

export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details)

export const unprocessable = (code: string, message: string, details?: unknown) =>
  new HttpError(422, code, message, details)
