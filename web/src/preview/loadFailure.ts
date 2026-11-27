/** Chromium reports connection failures separately from HTTP responses such as a 404. */
export function loadFailure(error: string, address: string | null) {
  let host = 'the server';
  let local = false;
  try {
    const url = new URL(address ?? '');
    host = url.host;
    local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { /* Some failures happen before an address commits. */ }
  const code = error.match(/\bERR_[A-Z_0-9]+\b/)?.[0] ?? error;
  switch (code) {
    case 'ERR_CONNECTION_REFUSED':
      return { title: 'Connection refused', detail: local
        ? `${host} refused the connection. Check that the app is running on that port.`
        : `${host} refused the connection. Check the address or try again when the server is available.`, code };
    case 'ERR_UNSAFE_PORT':
      return { title: 'Port blocked', detail: `The browser blocks the port on ${host}. Use the app’s HTTP preview port.`, code };
    case 'ERR_NAME_NOT_RESOLVED':
      return { title: 'Host not found', detail: `The name ${host} could not be resolved. Check the spelling and your network connection.`, code };
    case 'ERR_CONNECTION_TIMED_OUT':
    case 'ERR_TIMED_OUT':
      return { title: 'Connection timed out', detail: `${host} did not respond in time. Check that the server is reachable.`, code };
    case 'ERR_INTERNET_DISCONNECTED':
      return { title: 'Network disconnected', detail: `Reconnect to the network to reach ${host}.`, code };
    case 'ERR_CONNECTION_RESET':
    case 'ERR_CONNECTION_CLOSED':
    case 'ERR_EMPTY_RESPONSE':
      return { title: 'Connection closed', detail: `The connection to ${host} ended before the page loaded.`, code };
    default:
      if (code.startsWith('ERR_CERT_') || code.startsWith('ERR_SSL_')) {
        return { title: 'Secure connection failed', detail: `Check the HTTPS address and certificate for ${host}.`, code };
      }
      return { title: 'Page load failed', detail: `The browser could not finish loading the page from ${host}.`, code };
  }
}
