// Whoop login through Whoop's Cognito proxy, as the iOS app does.
// Copied from totem's src/whoop/cognito.ts (MIT, Brian Gao), so this tool doesn't depend on totem's internals.
//
//   login:   InitiateAuth (USER_PASSWORD_AUTH) → EMAIL_OTP challenge → RespondToAuthChallenge with the code
//   refresh: InitiateAuth (REFRESH_TOKEN_AUTH), no code needed
import { randomUUID } from "node:crypto";

const ENDPOINT = "https://api.prod.whoop.com/auth-service/v3/whoop/";
const USER_AGENT =
  "aws-sdk-swift/1.5.86 ua/2.1 api/cognito_identity_provider#1.5.86 os/ios#26.3.1 lang/swift#5.10 m/D,N,Z,b";
const TIMEOUT_MS = 30_000;

const CODE_FIELD: Record<string, string> = {
  EMAIL_OTP: "EMAIL_OTP_CODE",
  SMS_MFA: "SMS_MFA_CODE",
  SOFTWARE_TOKEN_MFA: "SOFTWARE_TOKEN_MFA_CODE",
};

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

interface AuthResult {
  AccessToken: string;
  RefreshToken?: string;
}

interface CognitoResponse {
  AuthenticationResult?: AuthResult;
  ChallengeName?: string;
  Session?: string;
}

export class CognitoError extends Error {
  notAuthorized: boolean;

  constructor(message: string, notAuthorized: boolean) {
    super(message);
    this.notAuthorized = notAuthorized;
  }
}

async function callCognito(target: string, body: object): Promise<CognitoResponse> {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": `AWSCognitoIdentityProviderService.${target}`,
        "amz-sdk-request": "attempt=1; max=1",
        "amz-sdk-invocation-id": randomUUID(),
        "user-agent": USER_AGENT,
        accept: "*/*",
        "accept-encoding": "gzip, deflate, br",
        "accept-language": "en-US,en;q=0.9",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") throw new Error(`Cognito ${target} timed out`);
    throw err;
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      detail = `${j.__type ?? "error"}: ${j.message ?? text}`;
    } catch {}
    throw new CognitoError(`Cognito ${target} failed (${res.status}): ${detail}`, detail.includes("NotAuthorizedException"));
  }
  return JSON.parse(text);
}

function tokens(result: AuthResult, previousRefresh?: string): Tokens {
  return {
    accessToken: result.AccessToken,
    refreshToken: result.RefreshToken ?? previousRefresh ?? "",
  };
}

// getCode() is called only if Whoop asks for a code.
export async function login(
  email: string,
  password: string,
  getCode: (challenge: string) => Promise<string>,
): Promise<Tokens> {
  const init = await callCognito("InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    AuthParameters: { USERNAME: email, PASSWORD: password },
    ClientId: "",
  });
  if (init.AuthenticationResult) return tokens(init.AuthenticationResult);

  const challenge = init.ChallengeName ?? "";
  const field = CODE_FIELD[challenge];
  if (!field) throw new Error(`Unexpected challenge from Whoop: ${challenge || "none"}`);
  if (!init.Session) throw new Error("Whoop's code challenge has no session");

  const code = String(await getCode(challenge)).trim();
  const resp = await callCognito("RespondToAuthChallenge", {
    ClientId: "",
    ChallengeName: challenge,
    Session: init.Session,
    ChallengeResponses: { USERNAME: email, [field]: code },
  });
  if (!resp.AuthenticationResult) throw new Error("Whoop accepted the code but returned no tokens");
  return tokens(resp.AuthenticationResult);
}

export async function refresh(refreshToken: string): Promise<Tokens> {
  const resp = await callCognito("InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    AuthParameters: { REFRESH_TOKEN: refreshToken },
    ClientId: "",
  });
  if (!resp.AuthenticationResult) throw new Error("Whoop's refresh returned no tokens");
  return tokens(resp.AuthenticationResult, refreshToken);
}

export function jwtExpiry(jwt: string): number {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
    return payload.exp ?? 0;
  } catch {
    return 0;
  }
}
