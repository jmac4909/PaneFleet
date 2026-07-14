## Outcome

Describe the operator-facing result and why it belongs in Host Control.

## Validation

- [ ] `npm run check`
- [ ] `npm run privacy:check`
- [ ] New host/process behavior is covered by isolated fixtures
- [ ] No terminal output, credentials, IPs, hostnames, private paths, or machine-local config is included

## Safety review

- [ ] No arbitrary shell or path endpoint was added
- [ ] Normal agent input remains literal text plus one Enter
- [ ] Exact tmux identity is revalidated before input
- [ ] Recovery/service/network mutations remain separate and visibly confirmed
- [ ] Ambiguous outcomes fail closed without automatic resend or Done
