---
title: Multi-user and the household
description: "How several people share one Hivekeep instance: accounts, invitations, the shared Agent session, and what each Agent knows about who is speaking."
---

Hivekeep is built for a household or a small group, not for one isolated user. Several people log in to the same instance, talk to the same Agents, and the Agents remember who is who. This page covers how accounts work, how to invite people, and what is shared between everyone versus what stays tied to an individual.

## The model in one paragraph

There is one instance, one database, and one continuous session per Agent. Everyone in the household shares the same squad of Agents. There are no private Agents. Each message an Agent receives is tagged with the identity of the person who sent it, so an Agent can recognise who it is talking to and adapt. Authentication is handled by Better Auth with HTTP-only cookie sessions.

## The first user and accounts

The first person to complete onboarding becomes the **admin**. Onboarding is minimal by design: its only job is to create that first account. Everything else, providers, default models, your first Agent, happens afterward from inside the app rather than as a setup wall.

A few specifics from how accounts are actually created:

- Onboarding is open only while no admin exists. The principle is "completed equals an admin exists": once an admin profile is present, the public onboarding path is closed and new accounts require an invitation.
- A new account needs both a Better Auth login (email and password, minimum 8 characters) and a Hivekeep **profile** (first name, last name, pseudonym, interface language, and optionally the Agent language). A login without a profile cannot reach any protected route; the middleware blocks it until onboarding is complete.
- The first account gets the `admin` role; everyone who joins through an invitation is a **member**.

## Roles: admin and member

A **member** uses the platform: they chat with the Agents, launch standalone tasks, manage their own profile, notification preferences, contacts, and stored files. An **admin** additionally owns the platform configuration: providers and models, channels, the Vault, custom tools, toolboxes, plugins, MCP servers, mini-app management, crons, Agent creation and deletion, email and connected accounts, webhooks, users and invitations, logs, usage, and updates. The settings navigation only shows members the sections they can use, and the API enforces the same split server-side.

Admins can promote a member to admin (or demote one) from Settings > Users; you can never change your own role, so at least one admin always remains.

:::note
Instances installed before roles were enforced had every account created as admin. On upgrade, a migration keeps the oldest admin and moves everyone else to member; re-promote from Settings > Users if some of them should stay admins.
:::

## Inviting people

Because open sign-up is closed once an admin exists, additional household members join through invitations.

1. From the app, an admin creates an invitation. You can give it a label and an expiry in days.
2. Hivekeep produces an invitation token (a link).
3. The invited person opens it, signs up, and completes their profile. The token is validated server-side, and is marked used once their account is created.

Invitations can be listed and revoked. A token that has already been used cannot be revoked (the account already exists). Deleting a user account cleans up their sessions, login records, and profile; contacts that referenced them are unlinked rather than deleted, so the Agents still retain what they learned about that person.

## What is shared versus per-user

Understanding the boundary matters when several people use the same instance.

**Shared across everyone:**

- **The Agents themselves** and their configuration. There is one squad; anyone can talk to any Agent.
- **The conversation with each Agent.** Messages are scoped to the Agent, not to a user, so a continuous, shared timeline is what each Agent works from. If one person asks an Agent something and another person opens the same Agent, they see the same conversation.
- **Global configuration** such as providers, default models, MCP servers, and Vault secrets.

**Tied to the individual:**

- **Login and session.** Each person has their own credentials and cookie session.
- **Profile and preferences.** First name, last name, pseudonym, interface language, Agent language (the language Agents speak to you, independent from the UI translation), and appearance settings (theme, palette, contrast) are stored per profile so they sync across that person's devices.
- **The author tag on each message.** Every message records its source, and a user message carries the identity of the person who sent it.

## How Agents recognise who is speaking

This is the payoff of multi-user. When an Agent processes a turn, Hivekeep injects a **Current speaker** block into its system prompt for that turn: the speaker's name and pseudonym, plus any notes the Agent or the household has recorded about that person. If the Agent has never met this person, it is told to introduce itself and ask a couple of natural questions, then save what it learns so every Agent benefits.

Because each person is also represented as a **contact**, notes about them can be shared (visible to all Agents) or private to a single Agent, and an Agent can enrich those notes naturally over time. The result is that "talk to the same Agent as everyone else" does not mean "the Agent treats everyone identically": it knows that a message from one household member is different from a message from another.

## Group conversations

Since the session is shared and messages are broadcast over the real-time connection, more than one person can be present in the same Agent conversation, including across devices. The Agent is given awareness of the participants so it can address people appropriately. The conversation stays one continuous thread; there is no notion of starting a separate private chat with a shared Agent.

## Related

- [Vault and secrets](/docs/features/vault/) for the shared, encrypted credential store admins manage.
- [Queenie, guided setup](/docs/features/queenie/) for the onboarding the first admin goes through.
- [Configuration](/docs/getting-started/configuration/) for authentication-related environment variables such as trusted origins and the auth secret.
