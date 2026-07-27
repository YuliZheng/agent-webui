import { request } from "./ws.js";

export interface MeResponse { home: string }

export async function getMe(): Promise<MeResponse> {
  return request<MeResponse>("get-me");
}
