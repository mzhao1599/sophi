/** The sign-in form's steps, shared by the server action and the form. */
export type SignInState =
  | { step: "email"; email: string; error: string | null }
  | { step: "code"; email: string; error: string | null; notice: string | null };

export const START: SignInState = { step: "email", email: "", error: null };
