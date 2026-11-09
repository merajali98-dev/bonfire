import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ONE_EMBER, ONE_NEAR } from "../src/rules.ts";
import { CANDIDATE_RULES } from "../src/scenarios.ts";

// The deploy script initializes the contract with these values, so they must be the ones the
// simulation report recommends and the sandbox replay runs.
test("the deploy script uses the rules the simulator recommends", () => {
  const script = readFileSync(new URL("../../../scripts/testnet.ts", import.meta.url), "utf8");
  const block = script.match(/rules: \{([^}]*)\}/)?.[1];
  assert.ok(block, "no rules block in scripts/testnet.ts");
  const field = (name: string) => {
    const value = block.match(new RegExp(`${name}: ([^,\\n]+)`))?.[1]?.trim();
    assert.ok(value, `${name} missing`);
    return value;
  };
  const amount = (value: string) => {
    const ember = value.match(/^ember\("(\d+)"\)\.toString\(\)$/);
    if (ember) return BigInt(ember[1]!) * ONE_EMBER;
    const near = value.match(/^near\("(\d+)"\)\.toString\(\)$/);
    if (near) return BigInt(near[1]!) * ONE_NEAR;
    return BigInt(value.replace(/_/g, ""));
  };
  assert.equal(amount(field("budget_bps")), CANDIDATE_RULES.budgetBps);
  assert.equal(amount(field("min_budget")), CANDIDATE_RULES.minBudget);
  assert.equal(amount(field("initial_threshold")), CANDIDATE_RULES.initialThreshold);
  assert.equal(amount(field("min_threshold")), CANDIDATE_RULES.minThreshold);
  assert.equal(amount(field("up_bps")), CANDIDATE_RULES.upBps);
  assert.equal(amount(field("down_bps")), CANDIDATE_RULES.downBps);
  assert.equal(amount(field("target_multiple")), CANDIDATE_RULES.targetMultiple);
});
