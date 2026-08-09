# Security policy

`pi-seatbelt-sandbox` is a macOS security boundary. Please do not disclose
sandbox bypasses, credential exposure, or other vulnerability details in a
public GitHub issue.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/thaodangspace/pi-seatbelt-sandbox/security/advisories/new>

If private reporting is unavailable, contact the repository maintainers through
the GitHub organization and include **Security report** in the subject. Please
include the affected version, macOS version, reproduction steps, and impact.
Do not include live credentials or secrets.

We will acknowledge a report within 5 business days, provide an initial
assessment within 10 business days, and coordinate a fix and disclosure date
with the reporter. These timelines are targets rather than a guarantee.

## Supported versions

The latest published release is supported. Older releases are evaluated on a
case-by-case basis; users should upgrade before reporting or relying on a fix.
The extension currently supports Pi SDK versions `>=0.80.0 <1`, which is the
peer compatibility range declared by the package. The CI lockfile exercises
the latest matching SDK version.

## Security-sensitive findings

Treat the following as security-sensitive: a Seatbelt profile bypass, access
to files outside the configured policy, unexpected network access, leakage of
inherited secrets, or a release/CI supply-chain compromise.
