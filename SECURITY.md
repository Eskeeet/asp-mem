# Security and privacy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability involving data exposure, tenant isolation, or prompt injection. Use GitHub's private vulnerability reporting for this repository.

## Memory is sensitive data

Conversational memory can contain identity, health, financial, relationship, location, or belief data. Production integrations should:

- obtain meaningful consent before long-term storage;
- minimize captured fields and reject credentials or secrets;
- define retention and expiry rules;
- encrypt data in transit and at rest;
- isolate every operation by owner/tenant;
- support access, export, correction, and deletion requests;
- avoid embedding data with a provider whose data policy is unacceptable for the use case.

The included Supabase schema enables row-level security for authenticated users. A service-role key bypasses those policies and must never be exposed to clients.

## Prompt injection

Stored memories are untrusted input. The default context renderer escapes markup and labels the block as data, but formatting alone is not a security boundary. Never derive tool authority, authentication, or data access from model output. Keep system instructions and authorization checks outside the model.

## Extraction accuracy

Model-generated memories can be wrong. The default extraction prompt only requests facts explicitly supplied by the user, but applications should validate domain-sensitive candidates and provide a user-facing way to inspect and correct stored memories.
