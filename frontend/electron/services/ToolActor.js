import { getToken } from './SessionStore.js';
/** Resolve identity from the backend's authenticated session, never IPC input.
 * Rechecked for each execution/approval so switching accounts invalidates scope. */
export async function resolveToolActor(senderId, { readToken=getToken, request=fetch } = {}) {
  const token=readToken();
  const fail=()=>{throw Object.assign(new Error('Authenticated tool session required.'),{code:'AUTH_CONTEXT_REQUIRED'});};
  if(typeof token!=='string' || !token || !Number.isSafeInteger(senderId) || senderId<1) fail();
  const response=await request('http://127.0.0.1:3001/api/auth/me',{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000),redirect:'error'});
  if(!response.ok || readToken()!==token) fail();
  const user=(await response.json())?.user;
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(user?.id??'') || readToken()!==token) fail();
  return `renderer:${user.id}-${senderId}`;
}
