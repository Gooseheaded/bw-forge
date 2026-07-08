"""Legacy scraper for historical reference data under raw-data/.

This script is retained for provenance and ad hoc data-checking, but the
replay-analysis runtime does not load from these scrape outputs directly.
"""

import os
import time
import urllib.request

BASE = "https://liquipedia.net/starcraft/"
OUT  = "raw-data"

PAGES = [
    # (race, type, name, url_slug)
    # ── Terran Units ──────────────────────────────────────────────
    ("terran", "units", "SCV",             "SCV"),
    ("terran", "units", "Marine",          "Marine"),
    ("terran", "units", "Firebat",         "Firebat"),
    ("terran", "units", "Medic",           "Medic"),
    ("terran", "units", "Ghost",           "Ghost"),
    ("terran", "units", "Vulture",         "Vulture"),
    ("terran", "units", "Siege Tank",      "Siege_Tank"),
    ("terran", "units", "Goliath",         "Goliath"),
    ("terran", "units", "Wraith",          "Wraith"),
    ("terran", "units", "Dropship",        "Dropship"),
    ("terran", "units", "Science Vessel",  "Science_Vessel"),
    ("terran", "units", "Battlecruiser",   "Battlecruiser"),
    ("terran", "units", "Valkyrie",        "Valkyrie"),
    # ── Terran Buildings ──────────────────────────────────────────
    ("terran", "buildings", "Command Center",    "Command_Center"),
    ("terran", "buildings", "Supply Depot",      "Supply_Depot"),
    ("terran", "buildings", "Refinery",          "Refinery"),
    ("terran", "buildings", "Barracks",          "Barracks"),
    ("terran", "buildings", "Engineering Bay",   "Engineering_Bay"),
    ("terran", "buildings", "Academy",           "Academy"),
    ("terran", "buildings", "Bunker",            "Bunker"),
    ("terran", "buildings", "Missile Turret",    "Missile_Turret"),
    ("terran", "buildings", "Factory",           "Factory"),
    ("terran", "buildings", "Starport",          "Starport"),
    ("terran", "buildings", "Armory",            "Armory"),
    ("terran", "buildings", "Science Facility",  "Science_Facility"),
    # ── Terran Addons ─────────────────────────────────────────────
    ("terran", "addons", "Comsat Station", "Comsat_Station"),
    ("terran", "addons", "Nuclear Silo",   "Nuclear_Silo"),
    ("terran", "addons", "Machine Shop",   "Machine_Shop"),
    ("terran", "addons", "Control Tower",  "Control_Tower"),
    ("terran", "addons", "Physics Lab",    "Physics_Lab"),
    ("terran", "addons", "Covert Ops",     "Covert_Ops"),
    # ── Terran Upgrades ───────────────────────────────────────────
    ("terran", "upgrades", "Stim Packs",          "Stimpack"),
    ("terran", "upgrades", "U-238 Shells",         "U-238_Shells"),
    ("terran", "upgrades", "Restoration",          "Restoration"),
    ("terran", "upgrades", "Optical Flare",        "Optical_Flare"),
    ("terran", "upgrades", "Caduceus Reactor",     "Caduceus_Reactor"),
    ("terran", "upgrades", "Tank Siege Mode",      "Siege_Mode"),
    ("terran", "upgrades", "Spider Mines",         "Spider_Mines"),
    ("terran", "upgrades", "Ion Thrusters",        "Ion_Thrusters"),
    ("terran", "upgrades", "Charon Boosters",      "Charon_Boosters"),
    ("terran", "upgrades", "Cloaking Field",       "Cloaking_Field"),
    ("terran", "upgrades", "Yamato Gun",           "Yamato_Gun"),
    ("terran", "upgrades", "Irradiate",            "Irradiate"),
    ("terran", "upgrades", "EMP Shockwave",        "EMP_Shockwave"),
    ("terran", "upgrades", "Lockdown",             "Lockdown"),
    ("terran", "upgrades", "Personnel Cloaking",   "Personal_Cloaking"),
    ("terran", "upgrades", "Terran Infantry Weapons", "Terran_Infantry_Weapons"),
    ("terran", "upgrades", "Terran Infantry Armor",   "Terran_Infantry_Armor"),
    ("terran", "upgrades", "Terran Vehicle Weapons",  "Terran_Vehicle_Weapons"),
    ("terran", "upgrades", "Terran Vehicle Plating",  "Terran_Vehicle_Plating"),
    ("terran", "upgrades", "Terran Ship Weapons",     "Terran_Ship_Weapons"),
    ("terran", "upgrades", "Terran Ship Plating",     "Terran_Ship_Plating"),
    # ── Protoss Units ─────────────────────────────────────────────
    ("protoss", "units", "Probe",        "Probe"),
    ("protoss", "units", "Zealot",       "Zealot"),
    ("protoss", "units", "Dragoon",      "Dragoon"),
    ("protoss", "units", "High Templar", "High_Templar"),
    ("protoss", "units", "Dark Templar", "Dark_Templar"),
    ("protoss", "units", "Archon",       "Archon"),
    ("protoss", "units", "Dark Archon",  "Dark_Archon"),
    ("protoss", "units", "Reaver",       "Reaver"),
    ("protoss", "units", "Shuttle",      "Shuttle"),
    ("protoss", "units", "Observer",     "Observer"),
    ("protoss", "units", "Scout",        "Scout"),
    ("protoss", "units", "Corsair",      "Corsair"),
    ("protoss", "units", "Carrier",      "Carrier"),
    ("protoss", "units", "Arbiter",      "Arbiter"),
    # ── Protoss Buildings ─────────────────────────────────────────
    ("protoss", "buildings", "Nexus",                "Nexus"),
    ("protoss", "buildings", "Pylon",                "Pylon"),
    ("protoss", "buildings", "Assimilator",          "Assimilator"),
    ("protoss", "buildings", "Gateway",              "Gateway"),
    ("protoss", "buildings", "Forge",                "Forge"),
    ("protoss", "buildings", "Photon Cannon",        "Photon_Cannon"),
    ("protoss", "buildings", "Cybernetics Core",     "Cybernetics_Core"),
    ("protoss", "buildings", "Robotics Facility",    "Robotics_Facility"),
    ("protoss", "buildings", "Stargate",             "Stargate"),
    ("protoss", "buildings", "Citadel of Adun",      "Citadel_of_Adun"),
    ("protoss", "buildings", "Robotics Support Bay", "Robotics_Support_Bay"),
    ("protoss", "buildings", "Fleet Beacon",         "Fleet_Beacon"),
    ("protoss", "buildings", "Templar Archives",     "Templar_Archives"),
    ("protoss", "buildings", "Observatory",          "Observatory"),
    ("protoss", "buildings", "Arbiter Tribunal",     "Arbiter_Tribunal"),
    ("protoss", "buildings", "Shield Battery",       "Shield_Battery"),
    # ── Protoss Upgrades ──────────────────────────────────────────
    ("protoss", "upgrades", "Leg Enhancements",      "Leg_Enhancements"),
    ("protoss", "upgrades", "Singularity Charge",    "Singularity_Charge"),
    ("protoss", "upgrades", "Scarab Damage",         "Scarab_Damage"),
    ("protoss", "upgrades", "Reaver Capacity",       "Reaver_Capacity"),
    ("protoss", "upgrades", "Gravitic Drive",        "Gravitic_Drive"),
    ("protoss", "upgrades", "Observer Speed",        "Gravitic_Boosters"),
    ("protoss", "upgrades", "Psionic Storm",         "Psionic_Storm"),
    ("protoss", "upgrades", "Hallucination",         "Hallucination"),
    ("protoss", "upgrades", "Khaydarin Amulet",      "Khaydarin_Amulet"),
    ("protoss", "upgrades", "Maelstrom",             "Maelstrom"),
    ("protoss", "upgrades", "Mind Control",          "Mind_Control"),
    ("protoss", "upgrades", "Disruption Web",        "Disruption_Web"),
    ("protoss", "upgrades", "Carrier Capacity",      "Carrier_Capacity"),
    ("protoss", "upgrades", "Argus Jewel",           "Argus_Jewel"),
    ("protoss", "upgrades", "Recall",                "Recall"),
    ("protoss", "upgrades", "Stasis Field",          "Stasis_Field"),
    ("protoss", "upgrades", "Khaydarin Core",        "Khaydarin_Core"),
    ("protoss", "upgrades", "Protoss Ground Weapons", "Protoss_Ground_Weapons"),
    ("protoss", "upgrades", "Protoss Ground Armor",   "Protoss_Ground_Armor"),
    ("protoss", "upgrades", "Protoss Air Weapons",    "Protoss_Air_Weapons"),
    ("protoss", "upgrades", "Protoss Air Armor",      "Protoss_Air_Armor"),
    ("protoss", "upgrades", "Protoss Plasma Shields", "Protoss_Plasma_Shields"),
    # ── Zerg Units ────────────────────────────────────────────────
    ("zerg", "units", "Drone",     "Drone"),
    ("zerg", "units", "Overlord",  "Overlord"),
    ("zerg", "units", "Zergling",  "Zergling"),
    ("zerg", "units", "Hydralisk", "Hydralisk"),
    ("zerg", "units", "Lurker",    "Lurker"),
    ("zerg", "units", "Mutalisk",  "Mutalisk"),
    ("zerg", "units", "Scourge",   "Scourge"),
    ("zerg", "units", "Ultralisk", "Ultralisk"),
    ("zerg", "units", "Defiler",   "Defiler"),
    ("zerg", "units", "Queen",     "Queen"),
    ("zerg", "units", "Guardian",  "Guardian"),
    ("zerg", "units", "Devourer",  "Devourer"),
    # ── Zerg Buildings ────────────────────────────────────────────
    ("zerg", "buildings", "Hatchery",          "Hatchery"),
    ("zerg", "buildings", "Lair",              "Lair"),
    ("zerg", "buildings", "Hive",              "Hive"),
    ("zerg", "buildings", "Extractor",         "Extractor"),
    ("zerg", "buildings", "Spawning Pool",     "Spawning_Pool"),
    ("zerg", "buildings", "Evolution Chamber", "Evolution_Chamber"),
    ("zerg", "buildings", "Creep Colony",      "Creep_Colony"),
    ("zerg", "buildings", "Sunken Colony",     "Sunken_Colony"),
    ("zerg", "buildings", "Spore Colony",      "Spore_Colony"),
    ("zerg", "buildings", "Hydralisk Den",     "Hydralisk_Den"),
    ("zerg", "buildings", "Spire",             "Spire"),
    ("zerg", "buildings", "Greater Spire",     "Greater_Spire"),
    ("zerg", "buildings", "Queens Nest",       "Queen%27s_Nest"),
    ("zerg", "buildings", "Ultralisk Cavern",  "Ultralisk_Cavern"),
    ("zerg", "buildings", "Defiler Mound",     "Defiler_Mound"),
    ("zerg", "buildings", "Nydus Canal",       "Nydus_Canal"),
    # ── Zerg Upgrades ─────────────────────────────────────────────
    ("zerg", "upgrades", "Metabolic Boost",      "Metabolic_Boost"),
    ("zerg", "upgrades", "Adrenal Glands",       "Adrenal_Glands"),
    ("zerg", "upgrades", "Muscular Augments",    "Muscular_Augments"),
    ("zerg", "upgrades", "Grooved Spines",       "Grooved_Spines"),
    ("zerg", "upgrades", "Lurker Aspect",        "Lurker_Aspect"),
    ("zerg", "upgrades", "Pneumatized Carapace", "Pneumatized_Carapace"),
    ("zerg", "upgrades", "Ventral Sacs",         "Ventral_Sacs"),
    ("zerg", "upgrades", "Antennae",             "Antennae"),
    ("zerg", "upgrades", "Burrow",               "Burrow"),
    ("zerg", "upgrades", "Spawn Broodlings",     "Spawn_Broodlings"),
    ("zerg", "upgrades", "Ensnare",              "Ensnare"),
    ("zerg", "upgrades", "Anabolic Synthesis",   "Anabolic_Synthesis"),
    ("zerg", "upgrades", "Chitinous Plating",    "Chitinous_Plating"),
    ("zerg", "upgrades", "Plague",               "Plague"),
    ("zerg", "upgrades", "Dark Swarm",           "Dark_Swarm"),
    ("zerg", "upgrades", "Consume",              "Consume"),
    ("zerg", "upgrades", "Zerg Melee Attacks",   "Zerg_Melee_Attacks"),
    ("zerg", "upgrades", "Zerg Missile Attacks", "Zerg_Missile_Attacks"),
    ("zerg", "upgrades", "Zerg Carapace",        "Zerg_Carapace"),
    ("zerg", "upgrades", "Zerg Flyer Attacks",   "Zerg_Flyer_Attacks"),
    ("zerg", "upgrades", "Zerg Flyer Carapace",  "Zerg_Flyer_Carapace"),
]

def fetch(url):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "bw-quiz-data-fetcher/1.0 (educational project)"}
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode("utf-8", errors="replace")

def fetch_with_backoff(url, name):
    delays = [10, 30, 60, 120]
    for attempt, delay in enumerate(delays, 1):
        try:
            return fetch(url)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                if attempt < len(delays):
                    print(f"429 rate-limited, waiting {delay}s (attempt {attempt}/{len(delays)})...", flush=True)
                    time.sleep(delay)
                else:
                    raise
            else:
                raise

failed = []

for race, kind, name, url_slug in PAGES:
    folder = os.path.join(OUT, race, kind)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, url_slug + ".html")

    if os.path.exists(path):
        print(f"[exists] {name}")
        continue

    url = BASE + url_slug
    print(f"Fetching {name} ... {url}", end=" ", flush=True)
    try:
        html = fetch_with_backoff(url, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(html)
        print("OK")
    except Exception as e:
        print(f"FAILED: {e}")
        failed.append((name, url, str(e)))

    time.sleep(5)

print(f"\nDone. {len(PAGES) - len(failed)} fetched, {len(failed)} failed.")
if failed:
    print("\nFailed:")
    for name, url, err in failed:
        print(f"  {name}: {err}")
