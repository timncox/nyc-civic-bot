/**
 * Onboarding flow: resolve a user's address to districts,
 * create or find MMP group chats, and add the user.
 */

import { McpClient } from "./mcp-client.js";
import {
  upsertUserDistrict,
  getUserDistrict,
  getDistrictGroup,
  upsertDistrictGroup,
  type UserDistrict,
  type DistrictGroup,
} from "./db.js";

// --- Types for nyc-civic lookup_address response ---

interface LookupResult {
  council?: number;
  stateAssembly?: number;
  stateSenate?: number;
  congressional?: number;
  communityBoard?: string;
  electionDistrict?: number;
  borough?: string;
  lat: number;
  lng: number;
}

// --- Types for MMP group creation response ---

interface MmpGroupResult {
  thread_id: string;
  name: string;
}

// --- District tier definitions ---

const TIERS = [
  { tier: "council", keyFn: (d: LookupResult) => d.council ? `council-${d.council}` : null, numFn: (d: LookupResult) => d.council ?? null, nameFn: (n: number) => `NYC Council District ${n}` },
  { tier: "assembly", keyFn: (d: LookupResult) => d.stateAssembly ? `assembly-${d.stateAssembly}` : null, numFn: (d: LookupResult) => d.stateAssembly ?? null, nameFn: (n: number) => `NY Assembly District ${n}` },
  { tier: "borough", keyFn: (d: LookupResult) => d.borough ? `borough-${d.borough.toLowerCase().replace(/\s+/g, "-")}` : null, numFn: () => null, nameFn: (_n: number, d: LookupResult) => `NYC ${d.borough} Civic Chat` },
] as const;

/**
 * Onboard a user: look up their address, save district info,
 * create or find group chats, and add them to each group.
 *
 * Returns a summary of what happened.
 */
export async function onboardUser(
  mmpClient: McpClient,
  civicClient: McpClient,
  mmpUserId: string,
  mmpHandle: string,
  address: string,
): Promise<string> {
  // 1. Resolve address to districts
  let lookup: LookupResult;
  try {
    lookup = await civicClient.call<LookupResult>("lookup_address", { address });
  } catch (err) {
    return `Sorry, I couldn't resolve that address. Please try a full NYC street address (e.g. "350 5th Ave, New York, NY"). Error: ${(err as Error).message}`;
  }

  if (!lookup.council && !lookup.stateAssembly) {
    return `That address doesn't appear to be in New York City. Please provide an NYC street address.`;
  }

  // 2. Save user district info
  const userDistrict: UserDistrict = {
    mmp_user_id: mmpUserId,
    mmp_handle: mmpHandle,
    address,
    council_district: lookup.council ?? null,
    assembly_district: lookup.stateAssembly ?? null,
    election_district: lookup.electionDistrict ?? null,
    borough: lookup.borough ?? null,
    lat: lookup.lat,
    lng: lookup.lng,
    joined_at: Math.floor(Date.now() / 1000),
  };
  upsertUserDistrict(userDistrict);

  // 3. For each tier, find or create the group and add the user
  const joined: string[] = [];

  for (const tierDef of TIERS) {
    const key = tierDef.keyFn(lookup);
    if (!key) continue;

    const districtNum = tierDef.numFn(lookup);
    let group = getDistrictGroup(key);

    if (!group) {
      // Create a new MMP group for this district
      const groupName = tierDef.nameFn(districtNum as number, lookup);
      try {
        const result = await mmpClient.call<MmpGroupResult>("mmp-create-group", {
          name: groupName,
          members: [mmpHandle],
        });
        group = {
          district_key: key,
          tier: tierDef.tier,
          mmp_thread_id: result.thread_id,
          district_number: districtNum,
          created_at: Math.floor(Date.now() / 1000),
        };
        upsertDistrictGroup(group);
        joined.push(groupName);
      } catch (err) {
        console.error(`Failed to create group ${key}:`, err);
        continue;
      }
    } else {
      // Group exists — add the user
      try {
        await mmpClient.call("mmp-add-member", {
          thread_id: group.mmp_thread_id,
          handle: mmpHandle,
        });
        const groupName = tierDef.nameFn(districtNum as number, lookup);
        joined.push(groupName);
      } catch (err) {
        console.error(`Failed to add ${mmpHandle} to ${key}:`, err);
        continue;
      }
    }
  }

  if (joined.length === 0) {
    return `Your address was resolved but I couldn't add you to any district groups. Please try again later.`;
  }

  return `Welcome! You've been added to:\n${joined.map((g) => `  • ${g}`).join("\n")}\n\nYou'll receive civic updates for your districts. Type "my reps" in any group to see your elected officials.`;
}

/**
 * Check if a user is already onboarded.
 */
export function isOnboarded(mmpUserId: string): boolean {
  return getUserDistrict(mmpUserId) !== null;
}
