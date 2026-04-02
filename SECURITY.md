# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

Only the current major version (1.x) receives security updates. Please ensure you are running the latest patch release before reporting a vulnerability.

## Reporting a Vulnerability

**Do NOT report security vulnerabilities via public GitHub issues.**

If you discover a security issue, please email us directly at [mihairo.dev@gmail.com](mailto:mihairo.dev@gmail.com) with a detailed description of the vulnerability.

We will acknowledge receipt of your report within **72 hours** and provide a more detailed response outlining the next steps. We will keep you informed of our progress until the issue is resolved.

## What to Include

When submitting a report, please include:

- **Description** of the vulnerability and its potential impact
- **Steps to reproduce** the issue (proof-of-concept code or screenshots if applicable)
- **Affected version(s)** of `@mihairo/loqui`
- **Your contact information** for follow-up questions

## Responsible Disclosure

We ask that you:

- Give us a reasonable amount of time to address the issue before disclosing it publicly
- Avoid accessing or modifying other users' data beyond what is necessary to demonstrate the vulnerability
- Do not exploit the vulnerability for malicious purposes

We are committed to working with the security community to responsibly address all reported vulnerabilities and will credit reporters in our release notes (unless you prefer to remain anonymous).

## Security Considerations

`@mihairo/loqui` handles sensitive credentials including API keys for Gemini, OpenAI, and Anthropic. If you discover any issues related to:

- API key leakage or exposure in logs, errors, or output
- Insecure handling of environment variables
- Data sent to LLM providers that should remain local
- Any other credential or secret management concerns

Please report them immediately using the process above.
