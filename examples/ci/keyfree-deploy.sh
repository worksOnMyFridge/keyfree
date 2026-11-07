#!/usr/bin/env bash
# Deploys one contract through a Keyfree policy from CI. The job holds no EVM key, only the agent's NEAR
# function-call key, which can ask the policy and nothing else; the policy decides, NEAR MPC signs.
#
#   KEYFREE         the built keyfree CLI (.../packages/keyfree/dist/cli.js)
#   CONFIG          the project's keyfree.json: the policy, the agent account, the chains
#   CHAIN           a chain name from CONFIG, e.g. base-sepolia
#   ARTIFACT        the compiled contract (Foundry or Hardhat JSON with abi and bytecode)
#   ARGS            constructor arguments as a JSON array, e.g. ["0xTreasury..."]
#   AGENT_KEY_JSON  the agent's key file contents, from a CI secret (or set KEYFREE_AGENT_KEY to a file instead)
#
# Exit codes: 0 deployed, 2 refused by the policy (nothing was signed), 1 any other error.
set -uo pipefail

for v in KEYFREE CONFIG CHAIN ARTIFACT ARGS; do
  [ -n "${!v:-}" ] || { echo "::error::$v is not set"; exit 1; }
done

# The secret goes to a file only this job can read, and is removed when the script ends.
if [ -n "${AGENT_KEY_JSON:-}" ]; then
  KEYFREE_AGENT_KEY="$(mktemp "${RUNNER_TEMP:-/tmp}/keyfree-agent.XXXXXX")"
  trap 'rm -f "$KEYFREE_AGENT_KEY"' EXIT
  chmod 600 "$KEYFREE_AGENT_KEY"
  printf '%s' "$AGENT_KEY_JSON" > "$KEYFREE_AGENT_KEY"
  export KEYFREE_AGENT_KEY
fi

summary() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"; fi; }
what="$(basename "$ARTIFACT") with $ARGS on $CHAIN"

# The preview signs nothing: the policy builds the transaction and says whether it would sign it.
node "$KEYFREE" preview --config "$CONFIG" --chain "$CHAIN" --artifact "$ARTIFACT" --args "$ARGS" > preview.json 2> preview.err
code=$?
if [ "$code" = 2 ]; then
  cat preview.err
  echo "::error title=Refused by the policy::$(head -n 1 preview.err)"
  summary "Refused by the policy, nothing was signed: $what. $(head -n 1 preview.err)"
  exit 2
elif [ "$code" != 0 ]; then
  cat preview.err
  exit 1
fi

node "$KEYFREE" deploy --config "$CONFIG" --chain "$CHAIN" --artifact "$ARTIFACT" --args "$ARGS" > deploy.json 2> deploy.err
code=$?
cat deploy.json deploy.err
if [ "$code" = 2 ]; then
  echo "::error title=Refused by the policy::$(head -n 1 deploy.err)"
  summary "Refused by the policy, nothing was signed: $what. $(head -n 1 deploy.err)"
  exit 2
elif [ "$code" != 0 ]; then
  exit 1
fi

line="$(node -e 'const d = JSON.parse(require("fs").readFileSync("deploy.json", "utf8"));
  console.log(`Deployed ${process.argv[1]} at ${d.address}: ${d.links.evm} (NEAR ${d.links.near})`)' "$what")"
echo "$line"
summary "$line"
