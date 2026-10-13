/** An error caused by the request (bad input, missing folder…): reported as HTTP 400 with its message. */
export const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
