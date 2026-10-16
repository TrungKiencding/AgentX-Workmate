// Hosts a link title is never fetched from: this machine, the local network,
// and address space no public page lives in. On literal addresses it blocks
// what the backend's SSRF guard blocks (tools/url_safety.py `_is_blocked_ip`);
// on names, the ones that only resolve inside a network.
//
// Takes a WHATWG `URL.hostname`. The parser has already written every IPv4
// form (decimal, hex, octal, short) as a dotted quad, and every IPv6 one
// bracketed, compressed and in hex. electron/private-network-host.ts holds the
// same classifier for the main process, and the tests check the two agree.

const PRIVATE_IPV4 = [
  '0.0.0.0/8', // "this network": 0.0.0.0 reaches this machine
  '10.0.0.0/8', // RFC 1918
  '100.64.0.0/10', // carrier-grade NAT and Tailscale; Alibaba's metadata is 100.100.100.200
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local; cloud metadata is 169.254.169.254
  '172.16.0.0/12', // RFC 1918
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // documentation
  '192.168.0.0/16', // RFC 1918
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // documentation
  '203.0.113.0/24', // documentation
  '224.0.0.0/3' // multicast, reserved and broadcast
].map(cidr => {
  const [address, bits] = cidr.split('/')
  const size = 2 ** (32 - Number(bits))

  return { block: Math.floor((ipv4Value(address) ?? 0) / size), size }
})

// localhost and test (RFC 6761), mDNS .local, .internal (metadata.google.internal),
// home.arpa (RFC 8375), the lan/home/corp/intranet/private TLDs no registry
// delegates, and GCP's metadata.goog.
const PRIVATE_NAME_RE =
  /(?:^|\.)(?:corp|home|home\.arpa|internal|intranet|lan|local|localhost|metadata\.goog|private|test)$/

function ipv4Value(host: string): null | number {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)?.slice(1).map(Number)

  if (!parts || parts.some(part => part > 255)) {
    return null
  }

  return parts.reduce((value, part) => value * 256 + part, 0)
}

function isPrivateIpv4(value: number): boolean {
  return PRIVATE_IPV4.some(({ block, size }) => Math.floor(value / size) === block)
}

// "[fe80::1]" → its eight 16-bit groups, or null.
function ipv6Groups(host: string): null | number[] {
  const halves = /^\[([\da-f:]+)\]$/.exec(host)?.[1].split('::')

  if (!halves || halves.length > 2) {
    return null
  }

  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length

  // "::" stands for one or more zero groups; without it there must be eight.
  if (halves.length === 2 ? missing < 1 : missing !== 0) {
    return null
  }

  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail]

  return groups.every(group => /^[\da-f]{1,4}$/.test(group)) ? groups.map(group => parseInt(group, 16)) : null
}

function isPrivateIpv6(groups: number[]): boolean {
  const [first, second] = groups

  // ::ffff:a.b.c.d is an IPv4 address in IPv6 form: judge the IPv4 one.
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return isPrivateIpv4(groups[6] * 0x10000 + groups[7])
  }

  // Global unicast is 2000::/3. Outside it are ::, ::1, NAT64, unique local
  // fc00::/7 (AWS metadata is fd00:ec2::254), link-local fe80::/10 and multicast.
  if (first < 0x2000 || first > 0x3fff) {
    return true
  }

  return (
    (first === 0x2001 && second < 0x200) || // IETF protocol assignments, Teredo among them
    (first === 0x2001 && second === 0xdb8) || // documentation
    first === 0x2002 || // 6to4, which wraps an IPv4 address
    (first === 0x3fff && second < 0x1000) // documentation
  )
}

export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')

  if (host.startsWith('[')) {
    const groups = ipv6Groups(host)

    // An IPv6 literal this can't read is refused, not fetched.
    return !groups || isPrivateIpv6(groups)
  }

  const ipv4 = ipv4Value(host)

  if (ipv4 !== null) {
    return isPrivateIpv4(ipv4)
  }

  // A single label ("intranet", "nas") resolves through the network's search
  // domains.
  return !host.includes('.') || PRIVATE_NAME_RE.test(host)
}
