# Security policy

## Use RADIMCOM on a trusted network only

**Trusted network only, never expose RADIMCOM to the internet.**

RADIMCOM has no login or password, and by default it listens on all network interfaces (`host` is `0.0.0.0`, port 8434).
Anyone who can reach that port can control the receivers. With a LimeSDR attached, that can include enabling the
transmitter, and you are responsible for every transmission.

- Do not forward the port on your router and do not run RADIMCOM on a public address.
- If you use it only on the PC it runs on, set `host` to `127.0.0.1` in the configuration.
- For access from outside your network, use a VPN to your network.

The missing login is a known limitation, so there is no need to report it.

## Supported versions

Only the [latest release](https://github.com/om2amr/RADIMCOM/releases/latest) gets security fixes.

## Reporting a vulnerability

Please do not report vulnerabilities in public issues or discussions. Write to **radim.mutina@gmail.com** with:

- the RADIMCOM version
- what the problem is and what an attacker could do with it
- the steps to reproduce it

RADIMCOM is maintained by one person in their spare time, so replies and fixes are best effort. Please allow time for a
fix before you publish details.
