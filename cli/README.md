# @axon/cli

Operator command-line tool for Axon gateway operators.

## Install

```bash
npm install -g @axon/cli
```

Or run without installing:

```bash
npx @axon/cli <command>
```

## Quick start

```bash
export AXON_URL=https://axon-xxx.onrender.com
export AXON_ADMIN_KEY=...            # from your Render env

# Create a user
axon user:create --email=alice@acme.dev

# Check their balance (copy the api_key from above)
AXON_KEY=ax_live_abc... axon balance

# Credit their wallet manually
axon topup --user=<uuid> --amount=25

# Set a policy: $10/day budget, deny expensive APIs
axon policy:set --user=<uuid> --daily=10 --deny=replicate,runway,stability

# Public stats
axon stats

# Trigger settlement now
axon settle

# List catalog
axon catalog
```

## All commands

See `axon help` for full list.

## License

MIT
