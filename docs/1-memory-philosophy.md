# Memory Philosophy

Language: English | [Japanese](1-memory-philosophy.ja.md)

## Summary

`github-rag-mcp` is based on a simple idea:

GitHub can act as shared working memory for AI software work.

The system does not aim for complete memory. It aims for recoverable state.

## The problem

Many memory systems try to remember every conversation.

That approach has two common failure modes:

- unnecessary information accumulates and makes retrieval noisy
- important constraints disappear during summarization

For software work, both are expensive. A later agent may confidently continue from the wrong state.

## The design stance

This project uses the following stance:

- do not add unnecessary information
- do not remove information required for the next correct action
- preserve state in durable, human-visible artifacts

That means memory is not treated as a private archive of everything the model saw.

It is treated as a state recovery layer over artifacts that already matter:

- issue bodies and labels
- pull requests and review state
- repository docs
- releases

## Why this matters for multi-agent work

Multi-agent systems need more than storage. They need a stable interface.

GitHub already gives a natural interface:

- issues describe what the work is
- pull requests describe what changed
- docs describe what has stabilized
- releases describe what shipped

When retrieval is built over those surfaces, agents can hand work to each other without depending on hidden chat memory.

## Why this matters for session handoff

Session boundaries are normal.

A later session should not have to replay the entire chat transcript to recover the current state.

Instead it should be able to ask:

- what is this task
- what constraints were accepted
- what is already implemented
- what is still open
- what was released

That is the state this project tries to preserve and retrieve.

## What this project is not

It is not:

- a complete transcript archive
- an attempt to capture every thought
- a substitute for source-of-truth GitHub artifacts

It is a retrieval layer that helps agents recover the right state from those artifacts.
