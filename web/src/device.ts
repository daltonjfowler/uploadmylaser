// A random id per browser, sent as `x-device-id` with the class phrase and the teacher key, so the
// server's wrong-try lockout counts each device on its own (a school shares one public IP, and one
// student guessing must never lock out the class or the teacher). Not a credential.

const DEVICE_KEY = 'uml.device';
let memo = ''; // when storage is blocked: one id per page load

export function deviceId(): string {
  if (memo) return memo;
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    memo = id;
  } catch {
    memo = crypto.randomUUID();
  }
  return memo;
}
