import { stableConfiguration } from "../protocol/snapshot.js";
import { canonicalJson, sha256Bytes } from "../shared/util.js";

// The desired hash alone is not enough: a Satellite edit or an incomplete previous
// application must make an unchanged Primary snapshot eligible for repair.
export function configurationHash(value) {
  return sha256Bytes(canonicalJson({ defined: value !== undefined, value: stableConfiguration(value) }));
}

export function configuredFieldsEqual(actual, desired) {
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(desired || {}).every(([key, value]) =>
    configurationHash(actual[key]) === configurationHash(value));
}


// Include only mappings actually referenced by this object in its desired hash.
// Otherwise a proxy identity revision can leave a profile pointing at the old
// proxy even when the source profile document itself has not changed.
export function referencedMappings(value, mapping) {
  const used = {};
  const visit = (item) => {
    if (typeof item === "string") {
      if (Object.hasOwn(mapping, item)) used[item] = mapping[item];
    } else if (Array.isArray(item)) for (const child of item) visit(child);
    else if (item && typeof item === "object") for (const child of Object.values(item)) visit(child);
  };
  visit(value);
  return used;
}

export class AppliedObjectState {
  constructor(previous = {}) {
    this.entries = structuredClone(previous && typeof previous === "object" ? previous : {});
  }

  #key(kind, sourceId) { return `${kind}|${sourceId}`; }

  async matches(kind, sourceId, targetId, desired, observe) {
    const previous = this.entries[this.#key(kind, sourceId)];
    if (!previous || previous.target_id !== String(targetId) || previous.desired_hash !== configurationHash(desired)) return false;
    // A purely desired-state record is appropriate only for the active-profile
    // selection (Core does not consistently expose its selected profile).
    if (!observe) return true;
    if (!previous.observed_hash) return false;
    try {
      const current = await observe();
      return current != null && configurationHash(current) === previous.observed_hash;
    } catch { return false; } // An unreadable object is never silently treated as unchanged.
  }

  async remember(kind, sourceId, targetId, desired, observe) {
    let observedHash = null;
    if (observe) {
      try {
        const current = await observe();
        if (current != null) observedHash = configurationHash(current);
      } catch { /* Disable skipping until this object can be verified. */ }
    }
    this.entries[this.#key(kind, sourceId)] = {
      target_id: String(targetId), desired_hash: configurationHash(desired), observed_hash: observedHash
    };
  }

  forget(kind, sourceId) { delete this.entries[this.#key(kind, sourceId)]; }
}
