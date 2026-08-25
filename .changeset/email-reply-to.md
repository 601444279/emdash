---
"emdash": minor
"@emdash-cms/auth": minor
"@emdash-cms/sandbox-workerd": patch
---

Adds an optional `replyTo` field to `EmailMessage` so plugins can set a Reply-To address when sending email through `ctx.email.send()`.

The field is threaded through the entire email pipeline (`email:beforeSend`, `email:deliver`, and `email:afterSend`) and is preserved by the built-in dev-console provider and the workerd sandbox bridge. Email providers that support Reply-To headers can now read `message.replyTo` from the delivery event and include it in the outgoing message.

Usage from a plugin:

```ts
await ctx.email.send({
	to: "staff@hotel.com",
	replyTo: "jane@example.com",
	subject: "Availability request",
	text: "Hi, do you have rooms in March?",
});
```

This change is backwards compatible: existing emails without `replyTo` behave exactly as before.
