# Milestone 04 — Optional LLM

## Objective

Add an optional AI interpretation layer without turning Inspect It into an AI wrapper.

## Implement

OpenAI-compatible provider interface.

Support:

- OpenAI
- Ollama
- LM Studio
- arbitrary OpenAI-compatible endpoints

Configuration:

- provider
- base URL
- model
- API key

## Critical privacy rules

LLM functionality is OFF by default.

Local analysis must work without an LLM.

Never silently send data.

Show exactly what information will be sent.

Prefer structured local analysis over raw file transmission.

Support local LLM endpoints.

## AI output

AI may:

- summarize
- explain
- contextualize
- identify relationships
- suggest questions

AI must NOT overwrite local findings.

Clearly label AI-generated content.

## Testing

Use mocked OpenAI-compatible endpoints.

No real API keys in tests.