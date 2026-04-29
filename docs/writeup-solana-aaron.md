# Solana — Aaron

## What I built

I implemented the Solana side of the bridge as an Anchor program (`programs/bridge`).
The program owns three pieces of state: a singleton `BridgeConfig` account that holds
the bound source domain and the authorized relayer, a per-message `ProcessedMessage`
account that prevents replay, and an SPL mint whose mint authority is a program-derived
address. Four instructions sit on top of that state: `initialize` to set up
`BridgeConfig` once at deployment, `mint_wrapped` for the relayer to mint wrapped
tokens after observing an Ethereum lock event, and `set_paused` / `set_relayer` for
the admin to halt the system or rotate the relayer key.

I did not build the off-chain relayer (Leah & Harry's responsibility) or the
Ethereum-side lock contract (Yang's responsibility), and I did not implement a
k-of-n threshold scheme — the program trusts a single signer, matching the
deliberately simplified trust model the team adopted.

## Account model

I chose two on-chain account types because they encode two genuinely different
lifecycles. `BridgeConfig` is a singleton: it exists once per deployment and
mutates rarely. `ProcessedMessage` is per-message and exists only to prove a
nonce has been consumed.

The `BridgeConfig` PDA is seeded from `["config"]` — a constant. There is only
one bridge per program deployment, so a more complex seed scheme would not buy
anything. I cached the bump alongside the data so subsequent instructions don't
need to re-derive it; cheaper compute, and the canonical Anchor pattern.

The `ProcessedMessage` seed is the part of the design I spent the most time on.
The naive choice is `["processed", nonce_le]`, which works for a single source
chain bound to a single source contract. But that scheme implicitly assumes the
program will never need to recognize a second source. If we ever added a second
Sepolia bridge contract, or a second source chain, two distinct messages with the
same nonce would collide. So I went with
`["processed", source_chain_id_le, source_bridge, nonce_le]`. The replay namespace
becomes "this message identity from this source bridge on this source chain,"
which generalizes cleanly.

The mint authority lives at its own PDA, derived from `["mint_authority"]`.
Putting authority on a separate PDA — instead of using `BridgeConfig` itself
— matters because `BridgeConfig` is mutable. If a later instruction rewrote it,
nothing in the runtime would stop the mint authority from changing too. A
separate PDA can never have its data changed (it stores nothing), so the mint
authority is structurally immutable for the life of the deployment.

## The `mint_wrapped` instruction

The instruction's job is to verify a relayer-signed message and mint wrapped
tokens. The validation order matters because each check serves a different
purpose, and getting the order wrong leaks information through error codes.

1. `paused` first — fail fast under operational lockdown.
2. `authorized_relayer` second — refuse unsigned-by-relayer requests before doing
   any payload work.
3. `version == 1` — refuse messages from a future payload format we haven't
   audited.
4. `source_chain_id`, `source_bridge`, `source_token` — bind the message to the
   exact source we expect. A relayer with a stolen key still cannot mint from
   a different ERC-20 they happen to also have access to.
5. `wrapped_mint` matches `BridgeConfig.wrapped_mint` — defense against a
   relayer mistakenly passing the wrong mint account.
6. `amount > 0` — sanity.
7. Recipient consistency: the on-chain `recipient` account must match
   `payload.recipient_sol`, and the token account must equal the canonical ATA.

The recipient ATA check is enforced inside the program rather than trusted to
the relayer. This is a small extra cost in compute but means an audit can
verify the program never mints to the wrong account, even with a buggy relayer.

The CPI mint uses signer seeds for the `["mint_authority"]` PDA. This is the
classic Solana pattern for delegating signing authority to a program: the program
is the only entity that knows the seeds and bump that re-derive the authority,
so only this program can mint.

## Replay protection

Replay protection is the single most important property of any cross-chain
bridge, and Solana's account model gives a clean way to express it. The
`ProcessedMessage` account uses Anchor's `init` constraint, not `init_if_needed`.
The first submission for a given (chain, bridge, nonce) creates the PDA. Any
later submission for the same triplet derives the same PDA — and `init` fails
with "account already in use." That single mechanism is the entire replay
defense.

A subtle property here is that I did not need to write an explicit
`MessageAlreadyProcessed` error. The runtime returns "account already in use"
on duplicate `init`, which is sufficient for off-chain logging and triage.
Adding a custom error would mean an extra read and an extra branch — code
paths that could go wrong without making the system safer. Less code is better.

The reason this works at all is that Solana transactions are atomic. If the
mint CPI fails for any reason — wrong authority, bogus mint, anything — the
`ProcessedMessage` creation also reverts. So we cannot end up with a "processed"
record but no minted tokens, and we cannot end up with minted tokens but no
processed record. The two states are coupled by transaction atomicity, which
is what makes the relayer's retry policy safe: a failed retry leaves no trace.

## Token integration

I used the legacy SPL Token Program rather than Token-2022. Both are supported
by `anchor-spl`, but the Anchor TypeScript client and `@solana/spl-token` v0.3
target legacy Token first. For a project where a teammate's relayer code
already imports `@solana/spl-token@0.3.8`, breaking that compatibility for
features Token-2022 offers (transfer hooks, confidential transfers) wasn't
worth it.

ATA handling lives on the relayer side. The relayer issues an idempotent
ATA-creation instruction in the same transaction before `mint_wrapped`, using
`createAssociatedTokenAccountIdempotentInstruction`. This keeps the bridge
program smaller and avoids `init_if_needed`, which carries a known foot-gun
around re-initialization attacks if the program isn't careful to validate the
existing account. Doing it on the relayer side keeps the surface area small;
because both instructions are atomic in the same transaction, the user
experience is identical.

The CPI signer seeds for `mint_to` are `[b"mint_authority", &[bump]]`. The
bump is cached on `BridgeConfig` so we don't re-derive it on every call. This
is a tiny optimization but is the standard Anchor pattern.

## Tests

The Anchor test suite has 16 tests in TypeScript covering: initialize happy
path, initialize rejection when mint authority isn't transferred to the PDA,
admin/non-admin pause, admin/non-admin relayer rotation, mint_wrapped happy
path, eight distinct rejection cases (unauthorized relayer, paused, wrong
version, wrong chain id, wrong source bridge, wrong source token, zero amount,
wrong wrapped mint), and the duplicate-nonce replay test.

The single most important test is the duplicate-nonce one. It is the
quintessential cross-chain failure mode and the one a reviewer should look for
first. If that test passes and the others fail, the bridge is still safe; if
that test fails and everything else passes, the bridge is broken.

The local Anchor test loop catches bugs faster than Devnet does, and resets
state cleanly between runs. I treated `anchor test` as the inner dev loop and
Devnet as integration verification.

One small but real environment fix: Anchor 0.29's bundled validator launcher
defaulted to binding `0.0.0.0`, which the newer Agave 3.1.14 validator I had
installed rejects with `UnspecifiedIpAddr`. Adding `bind_address = "127.0.0.1"`
to `Anchor.toml`'s `[test.validator]` block fixed it. This kind of toolchain
seam is exactly the sort of thing local testing surfaces and Devnet would not.

## Devnet deployment notes

Deployment has one non-obvious step: after creating the wrapped SPL mint,
`setAuthority` must be called to transfer mint authority from the human deployer
to the program's `["mint_authority"]` PDA. My `initialize` instruction validates
this — it rejects initialization if the mint's authority isn't yet the PDA.
This caught my own deployment mistake the first time I ran the migration script
locally.

The migration script (`migrations/deploy.ts`) performs the three steps
deterministically: create mint, transfer authority, initialize config. It then
prints all the values the relayer team needs in their `.env`. I smoke-tested
this against a local validator end-to-end before considering the script done.

The initial Devnet deployment used placeholder ETH source addresses (all-zero
bytes) for `source_bridge` and `source_token`, because Yang's `EthBridge.sol`
and `TestToken.sol` contracts had not yet been deployed to Sepolia at that time.
Rather than redeploying the entire program once the real addresses became
available, I added a `set_source_binding` admin-only instruction. This
instruction lets the admin update the three source-binding fields
(`source_chain_id`, `source_bridge`, `source_token`) on the existing
`BridgeConfig` account without touching the program binary or the wrapped mint.
After Yang confirmed his Sepolia deployments, I ran `npm run anchor:update-source`
against Devnet to set the real addresses in-place: bridge contract
`0xb2f3b8465c6ab97ba8a7d5bb813a914d29a5dd24`, token contract
`0xd5f971eb46775dbd815ab866dfe888492acf7062`.

The values handed to the relayer team after Devnet deployment:
- Program ID (already fixed: `FaWcnbmoyN1SWfUaio4cJAC2HokPgukzKhhk1hZrh4De`)
- Wrapped mint pubkey
- BridgeConfig PDA (purely informational; they derive it themselves)
- Mint authority PDA (also informational)
- Authorized relayer pubkey (matches what we passed to `initialize`)

## What I would change with more time

1. **k-of-n threshold verification.** The single-relayer trust model is the
   biggest weakness, and the report's extension analysis already lays out the
   on-chain ed25519 sibling-instruction pattern. With another week, the program
   could verify that at least k signatures from a stored relayer set are present
   in the transaction's instructions sysvar.
2. **On-chain ATA `init_if_needed`.** Moving ATA creation into the program
   would simplify the relayer at the cost of a more careful re-init check.
   Doable, just not worth the risk on a tight deadline.
3. **Pre-flight balance check in `mint_wrapped`.** Catching an under-funded
   relayer earlier would produce a friendlier error than the Solana runtime's
   default insufficient-funds message.
