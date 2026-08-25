(function(){
"use strict";

/* =========================================================================
   0. CONSTANTS
   ========================================================================= */
const TILE = 32;
const GAME_VERSION = "2.1.0"; // bump this on every deploy - shown in Settings and on the start screen so players/devs can tell which build they're on
const CONSTRUCTION_SECONDS = 5; // how long a build/demolish/hire takes to actually complete (design feedback: shouldn't be instant)
// Map is sized to comfortably fit a randomly-generated T-shaped hospital footprint (see
// Hospital._generateShape) in any of its 4 possible orientations, at roughly 50% more total
// buildable area than the original fixed 24x8 + 8x9 T (design feedback).
const MAP_W = 32;   // tiles
const MAP_H = 26;   // tiles
// True if the whole rectangle [tx,ty,tx+tw,ty+th) lies inside the T-shaped footprint above -
// used by canPlaceRoom so nothing can be built in the "cut corners" outside the T.
const SAVE_KEY = "wacky_clinic_save_v2";
const DPR_CAP = 2.5;

// Static layout for the Hospital Guide (design feedback: a visual, pannable/zoomable map of how
// the game actually works - reception, then diagnosis, then treatment - grouped by room TYPE
// (all Consultation Rooms show as one node, however many are actually built) rather than one
// node per physical room instance. Positions are in a fixed virtual coordinate space; the
// viewport pans/zooms over it independently of the main game camera.
const ROOM_TREE_LAYOUT = {
  reception:          {x:40,  y:260, tier:0, hint:"Patients register here first"},
  consultation:       {x:260, y:260, tier:1, hint:"GP examines & diagnoses"},
  diagnostic:         {x:520, y:40,  tier:2, hint:"Extra diagnostic test"},
  cardiogram:         {x:520, y:150, tier:2, hint:"Extra diagnostic test"},
  scanner:            {x:520, y:260, tier:2, hint:"Extra diagnostic test"},
  ultrascan:          {x:520, y:370, tier:2, hint:"Extra diagnostic test"},
  bloodMachine:       {x:520, y:480, tier:2, hint:"Extra diagnostic test"},
  xray:               {x:520, y:590, tier:2, hint:"Extra diagnostic test"},
  ward:               {x:520, y:700, tier:2, hint:"Observation & recovery beds"},
  pharmacy:           {x:800, y:40,  tier:3, hint:"Dispenses the cure"},
  treatment:          {x:800, y:130, tier:3, hint:"General-purpose treatment"},
  operating:          {x:800, y:220, tier:3, hint:"Surgery - needs 2 surgeons"},
  psychiatric:        {x:800, y:310, tier:3, hint:"Talk therapy cures the mind"},
  inflation:          {x:800, y:400, tier:3, hint:"Re-inflates Bloaty Head"},
  deflation:          {x:800, y:490, tier:3, hint:"Deflates Puffy Head"},
  dnaFixer:           {x:800, y:580, tier:3, hint:"Untangles Alien DNA"},
  hairRestoration:    {x:1030,y:40,  tier:3, hint:"Cures Baldness"},
  slackTongueClinic:  {x:1030,y:130, tier:3, hint:"Trims an Overlong Tongue"},
  fractureClinic:     {x:1030,y:220, tier:3, hint:"Sets Fractured Bones"},
  electrolysis:       {x:1030,y:310, tier:3, hint:"Zaps away Hairyitis"},
  jellyVat:           {x:1030,y:400, tier:3, hint:"Firms up Jellyitis"},
  decontamination:    {x:1030,y:490, tier:3, hint:"Strips Serious Radiation"},
  staffroom:          {x:40,  y:820, tier:4, hint:"Staff rest & recover here"},
  toilets:            {x:190, y:820, tier:4, hint:"Keeps patients comfortable"},
  research:           {x:340, y:820, tier:4, hint:"Unlocks upgrades over time"},
  trainingRoom:       {x:490, y:820, tier:4, hint:"Consultants train Junior doctors"},
  waitingRoom:        {x:640, y:820, tier:4, hint:"Overflow seating near queues"},
};

// Isometric projection - identical constants/formula to the validated iso preview.
const TW = 64, TH = 32;      // tile diamond width/height on screen
const WALL_H = 40;           // wall height on screen
const WALL_H_OUTER = 56;     // hospital's outer shell reads taller than interior partition walls
function gridToScreen(gx,gy){ return { x:(gx-gy)*(TW/2), y:(gx+gy)*(TH/2) }; }
function screenToGrid(sx,sy){
  // inverse of gridToScreen
  const gx = (sx/(TW/2) + sy/(TH/2))/2;
  const gy = (sy/(TH/2) - sx/(TW/2))/2;
  return { x:gx, y:gy };
}

/* =========================================================================
   1. DATA DEFINITIONS - data-driven, embedded as JSON for now (see GAME_DATA
   below). This is deliberately kept as a literal JSON string, parsed once at
   load, so the intended split into diseases.json / rooms.json / staff.json /
   research.json / events.json later on is just "save this string to a file
   and fetch() it instead" - no restructuring needed.
   ========================================================================= */
const GAME_DATA = JSON.parse(`{
  "config": {
    "roomOrder": [
      "reception",
      "consultation",
      "diagnostic",
      "pharmacy",
      "treatment",
      "operating",
      "staffroom",
      "toilets",
      "research",
      "waitingRoom",
      "cardiogram",
      "scanner",
      "ultrascan",
      "bloodMachine",
      "xray",
      "ward",
      "psychiatric",
      "inflation",
      "dnaFixer",
      "hairRestoration",
      "slackTongueClinic",
      "fractureClinic",
      "electrolysis",
      "jellyVat",
      "decontamination",
      "trainingRoom"
    ],
    "lockedRoomOrder": [
      "deflation"
    ],
    "waitingRoomRangeTiles": 9,
    "staffRanks": {
      "junior": {
        "minSkill": 1,
        "maxSkill": 249,
        "label": "Junior Doctor"
      },
      "doctor": {
        "minSkill": 250,
        "maxSkill": 799,
        "label": "Doctor"
      },
      "consultant": {
        "minSkill": 800,
        "maxSkill": 1000,
        "label": "Consultant"
      }
    },
    "specialties": {
      "researcher": {
        "salarySurcharge": 20,
        "trainingPoints": 50,
        "desc": "Speeds up Research Department output."
      },
      "psychiatrist": {
        "salarySurcharge": 30,
        "trainingPoints": 65,
        "desc": "Required to staff the Psychiatric Room."
      },
      "surgeon": {
        "salarySurcharge": 40,
        "trainingPoints": 80,
        "desc": "Required (x2) to staff the Operating Theatre."
      }
    },
    "roomCategories": {
      "diagnostic": "Diagnostic",
      "treatment": "Treatment",
      "clinic": "Specialist Clinics",
      "facility": "Facilities"
    }
  },
  "rooms": {
    "reception": {
      "id": "reception",
      "name": "Reception",
      "color": "#d9c2a0",
      "darkColor": "#b89b73",
      "minW": 3,
      "minH": 3,
      "maxW": 6,
      "maxH": 5,
      "cost": 400,
      "capacity": 2,
      "needsDoctor": false,
      "needsReceptionist": true,
      "desc": "Welcomes new patients.",
      "staffSlot": {
        "x": 0.5,
        "y": 0.28
      },
      "patientSlot": {
        "x": 0.5,
        "y": 0.62
      },
      "furniture": "desk",
      "diagnosisPower": 0,
      "energyCost": 15,
      "decayRate": 1.5,
      "category": "facility"
    },
    "consultation": {
      "id": "consultation",
      "name": "Consultation Room",
      "color": "#f0eee6",
      "darkColor": "#d0ccc0",
      "minW": 3,
      "minH": 3,
      "maxW": 5,
      "maxH": 5,
      "cost": 600,
      "capacity": 1,
      "needsDoctor": true,
      "needsReceptionist": false,
      "desc": "The doctor makes a diagnosis.",
      "staffSlot": {
        "x": 0.5,
        "y": 0.3
      },
      "patientSlot": {
        "x": 0.5,
        "y": 0.68
      },
      "furniture": "desk",
      "diagnosisPower": 30,
      "energyCost": 20,
      "decayRate": 2,
      "category": "diagnostic",
      "realWorldName": "GP's Office"
    },
    "diagnostic": {
      "id": "diagnostic",
      "name": "Diagnostic Room",
      "color": "#e4edf0",
      "darkColor": "#bdd0d6",
      "minW": 3,
      "minH": 3,
      "maxW": 5,
      "maxH": 5,
      "cost": 900,
      "capacity": 1,
      "needsDoctor": true,
      "needsReceptionist": false,
      "desc": "Confirms difficult diagnoses.",
      "staffSlot": {
        "x": 0.28,
        "y": 0.35
      },
      "patientSlot": {
        "x": 0.62,
        "y": 0.55
      },
      "furniture": "machine",
      "diagnosisPower": 48,
      "energyCost": 35,
      "decayRate": 4,
      "category": "diagnostic",
      "machine": "diagnosticScope",
      "realWorldName": "General Diagnosis"
    },
    "pharmacy": {
      "id": "pharmacy",
      "name": "Pharmacy",
      "color": "#eeeae8",
      "darkColor": "#cec6c0",
      "minW": 3,
      "minH": 3,
      "maxW": 5,
      "maxH": 5,
      "cost": 700,
      "capacity": 1,
      "needsDoctor": false,
      "needsNurse": true,
      "needsReceptionist": false,
      "desc": "Dispenses remedies.",
      "staffSlot": {
        "x": 0.5,
        "y": 0.3
      },
      "patientSlot": {
        "x": 0.5,
        "y": 0.68
      },
      "furniture": "desk",
      "diagnosisPower": 0,
      "energyCost": 20,
      "decayRate": 2,
      "category": "treatment"
    },
    "treatment": {
      "id": "treatment",
      "name": "Treatment Room",
      "color": "#eeeae8",
      "darkColor": "#cec6c0",
      "minW": 4,
      "minH": 4,
      "maxW": 6,
      "maxH": 6,
      "cost": 1400,
      "capacity": 1,
      "needsDoctor": true,
      "needsReceptionist": false,
      "desc": "Treatments requiring special equipment.",
      "staffSlot": {
        "x": 0.25,
        "y": 0.5
      },
      "patientSlot": {
        "x": 0.55,
        "y": 0.55
      },
      "furniture": "bed",
      "diagnosisPower": 0,
      "energyCost": 40,
      "decayRate": 5,
      "category": "treatment"
    },
    "operating": {
      "id": "operating",
      "name": "Operating Room",
      "color": "#d6e6ee",
      "darkColor": "#a8c4d2",
      "minW": 4,
      "minH": 4,
      "maxW": 6,
      "maxH": 6,
      "cost": 2200,
      "capacity": 2,
      "needsDoctor": true,
      "needsReceptionist": false,
      "desc": "Heavy, high-risk treatments. Needs 2 Surgeons working together.",
      "staffSlot": {
        "x": 0.25,
        "y": 0.45
      },
      "patientSlot": {
        "x": 0.55,
        "y": 0.55
      },
      "furniture": "operatingTable",
      "diagnosisPower": 0,
      "energyCost": 60,
      "decayRate": 6,
      "category": "treatment",
      "surgeonsRequired": 2,
      "machine": "operatingEquipment"
    },
    "staffroom": {
      "id": "staffroom",
      "name": "Staff Room",
      "color": "#e8e2d4",
      "darkColor": "#c6bca4",
      "minW": 3,
      "minH": 3,
      "maxW": 5,
      "maxH": 5,
      "cost": 500,
      "capacity": 4,
      "needsDoctor": false,
      "needsReceptionist": false,
      "desc": "Staff recover their energy here.",
      "staffSlot": {
        "x": 0.5,
        "y": 0.5
      },
      "patientSlot": {
        "x": 0.5,
        "y": 0.5
      },
      "furniture": "sofa",
      "diagnosisPower": 0,
      "energyCost": 10,
      "decayRate": 1,
      "category": "facility"
    },
    "toilets": {
      "id": "toilets",
      "name": "Restrooms",
      "color": "#e2e6e8",
      "darkColor": "#bcc4c8",
      "minW": 2,
      "minH": 2,
      "maxW": 4,
      "maxH": 4,
      "cost": 300,
      "capacity": 2,
      "needsDoctor": false,
      "needsReceptionist": false,
      "desc": "An essential need.",
      "staffSlot": {
        "x": 0.5,
        "y": 0.5
      },
      "patientSlot": {
        "x": 0.5,
        "y": 0.5
      },
      "furniture": "stalls",
      "diagnosisPower": 0,
      "energyCost": 8,
      "decayRate": 1.5,
      "category": "facility"
    },
    "research": {
      "id": "research",
      "name": "Research Lab",
      "color": "#dde8e6",
      "darkColor": "#b4cac6",
      "minW": 3,
      "minH": 3,
      "maxW": 5,
      "maxH": 5,
      "cost": 1600,
      "capacity": 3,
      "needsDoctor": false,
      "needsReceptionist": false,
      "needsResearcher": true,
      "desc": "Researchers generate research points here.",
      "staffSlot": {
        "x": 0.5,
        "y": 0.4
      },
      "patientSlot": {
        "x": 0.5,
        "y": 0.4
      },
      "furniture": "researchDesk",
      "diagnosisPower": 0,
      "energyCost": 30,
      "decayRate": 3,
      "category": "facility"
    },
    "deflation": {
      "id": "deflation",
      "name": "Deflation Room",
      "color": "#f0ddc8",
      "darkColor": "#d4b98e",
      "minW": 3,
      "minH": 3,
      "maxW": 5,
      "maxH": 5,
      "cost": 1100,
      "capacity": 1,
      "needsDoctor": true,
      "needsReceptionist": false,
      "desc": "Gently deflates over-inflated heads.",
      "staffSlot": {
        "x": 0.3,
        "y": 0.4
      },
      "patientSlot": {
        "x": 0.6,
        "y": 0.55
      },
      "furniture": "machine",
      "locked": true,
      "unlockedBy": "deflationRoom",
      "diagnosisPower": 0,
      "energyCost": 45,
      "decayRate": 4,
      "category": "clinic",
      "machine": "deflationMachine"
    },
    "waitingRoom": {
      "id": "waitingRoom",
      "name": "Waiting Room",
      "color": "#ede4d2",
      "darkColor": "#cfc0a0",
      "minW": 3,
      "minH": 3,
      "maxW": 8,
      "maxH": 8,
      "cost": 350,
      "capacity": 0,
      "needsDoctor": false,
      "needsReceptionist": false,
      "desc": "Seating so patients don't have to wait standing up. Seat count scales with room size.",
      "staffSlot": {
        "x": 0.5,
        "y": 0.5
      },
      "patientSlot": {
        "x": 0.5,
        "y": 0.5
      },
      "furniture": "waitingSeats",
      "diagnosisPower": 0,
      "energyCost": 5,
      "decayRate": 0.5,
      "category": "facility"
    },
    "cardiogram": {
      "id": "cardiogram",
      "name": "Cardiogram",
      "category": "diagnostic",
      "color": "#e4edf0",
      "darkColor": "#bdd0d6",
      "minW": 4,
      "minH": 4,
      "maxW": 6,
      "maxH": 6,
      "cost": 950,
      "capacity": 1,
      "needsDoctor": true,
      "needsReceptionist": false,
      "desc": "Reads the patient's heart rhythm for a clearer diagnosis.",
      "staffSlot": {
        "x": 0.28,
        "y": 0.35
      },
      "patientSlot": {
        "x": 0.62,
        "y": 0.55
      },
      "furniture": "machine",
      "machine": "cardiographMachine",
      "diagnosisPower": 42,
      "energyCost": 30,
      "decayRate": 3.5
    },
    "scanner": {
      "id": "scanner",
      "name": "Scanner",
      "category": "diagnostic",
      "color": "#e4edf0",
      "darkColor": "#bdd0d6",
      "minW": 5,
      "minH": 5,
      "maxW": 7,
      "maxH": 7,
      "cost": 1800,
      "capacity": 1,
      "needsDoctor": true,
      "needsReceptionist": false,
      "desc": "A full-body scan for advanced, hard-to-pin-down diagnoses.",
      "staffSlot": {
        "x": 0.25,
        "y": 0.3
      },
      "patientSlot": {
        "x": 0.6,
        "y": 0.55
      },
      "furniture": "machine",
      "machine": "scannerMachine",
      "diagnosisPower": 58,
      "energyCost": 50,
      "decayRate": 4.5
    },
    "ultrascan": {
      "id": "ultrascan",
      "name": "Ultrascan",
      "category": "diagnostic",
      "color": "#e4edf0",
      "darkColor": "#bdd0d6",
      "minW": 5,
      "minH": 5,
      "maxW": 7,
      "maxH": 7,
      "cost": 2000,
      "capacity": 1,
      "needsDoctor": true,
      "needsReceptionist": false,
      "desc": "The most advanced diagnostic imaging available.",
      "staffSlot": {
        "x": 0.25,
        "y": 0.3
      },
      "patientSlot": {
        "x": 0.6,
        "y": 0.55
      },
      "furniture": "machine",
      "machine": "ultrascanMachine",
      "diagnosisPower": 64,
      "energyCost": 55,
      "decayRate": 4.5
    },
    "bloodMachine": {
      "id": "bloodMachine",
      "name": "Blood Machine",
      "category": "diagnostic",
      "color": "#e4edf0",
      "darkColor": "#bdd0d6",
      "minW": 4,
      "minH": 4,
      "maxW": 6,
      "maxH": 6,
      "cost": 1000,
      "capacity": 1,
      "needsDoctor": true,
      "needsReceptionist": false,
      "desc": "Analyses blood samples to narrow down a diagnosis.",
      "staffSlot": {
        "x": 0.28,
        "y": 0.35
      },
      "patientSlot": {
        "x": 0.62,
        "y": 0.55
      },
      "furniture": "machine",
      "machine": "bloodMachine",
      "diagnosisPower": 45,
      "energyCost": 32,
      "decayRate": 3.5
    },
    "xray": {
      "id": "xray",
      "name": "X-Ray",
      "category": "diagnostic",
      "color": "#e4edf0",
      "darkColor": "#bdd0d6",
      "minW": 6,
      "minH": 6,
      "maxW": 8,
      "maxH": 8,
      "cost": 2400,
      "capacity": 1,
      "needsDoctor": true,
      "needsReceptionist": false,
      "desc": "Imaging for bones and dense tissue.",
      "staffSlot": {
        "x": 0.25,
        "y": 0.3
      },
      "patientSlot": {
        "x": 0.6,
        "y": 0.55
      },
      "furniture": "machine",
      "machine": "xrayMachine",
      "diagnosisPower": 66,
      "energyCost": 58,
      "decayRate": 5
    },
    "ward": {
      "id": "ward",
      "name": "Ward",
      "category": "diagnostic",
      "color": "#eef0e8",
      "darkColor": "#cdd2bd",
      "minW": 6,
      "minH": 6,
      "maxW": 9,
      "maxH": 9,
      "cost": 1600,
      "capacity": 6,
      "needsDoctor": true,
      "needsNurse": true,
      "needsReceptionist": false,
      "desc": "Observation, recovery and pre-op preparation. About 6 beds per nurse (nurses are the preferred staff here).",
      "staffSlot": {
        "x": 0.5,
        "y": 0.15
      },
      "patientSlot": {
        "x": 0.5,
        "y": 0.55
      },
      "furniture": "bed",
      "diagnosisPower": 18,
      "energyCost": 35,
      "decayRate": 3,
      "bedsPerNurse": 6
    },
    "psychiatric": {
      "id": "psychiatric",
      "name": "Psychiatric Room",
      "category": "clinic",
      "color": "#efe6f2",
      "darkColor": "#cdb9d4",
      "minW": 5,
      "minH": 5,
      "maxW": 7,
      "maxH": 7,
      "cost": 1500,
      "capacity": 1,
      "needsDoctor": true,
      "needsReceptionist": false,
      "needsSpecialty": "psychiatrist",
      "desc": "Both diagnoses and treats conditions of the mind. Needs a qualified Psychiatrist.",
      "staffSlot": {
        "x": 0.3,
        "y": 0.3
      },
      "patientSlot": {
        "x": 0.6,
        "y": 0.55
      },
      "furniture": "desk",
      "diagnosisPower": 50,
      "energyCost": 38,
      "decayRate": 3.5
    },
    "inflation": {
      "id": "inflation",
      "name": "Inflation Room",
      "category": "clinic",
      "color": "#f0ddc8",
      "darkColor": "#d4b98e",
      "minW": 4,
      "minH": 4,
      "maxW": 6,
      "maxH": 6,
      "cost": 1300,
      "capacity": 1,
      "needsDoctor": true,
      "needsReceptionist": false,
      "desc": "Carefully re-inflates patients suffering from Bloaty Head.",
      "staffSlot": {
        "x": 0.3,
        "y": 0.4
      },
      "patientSlot": {
        "x": 0.6,
        "y": 0.55
      },
      "furniture": "machine",
      "machine": "inflationMachine",
      "diagnosisPower": 0,
      "energyCost": 45,
      "decayRate": 4
    },
    "dnaFixer": {
      "id": "dnaFixer",
      "name": "DNA Fixer",
      "category": "clinic",
      "color": "#e2f0e0",
      "darkColor": "#b9d4b4",
      "minW": 5,
      "minH": 5,
      "maxW": 7,
      "maxH": 7,
      "cost": 2600,
      "capacity": 1,
      "needsDoctor": true,
      "needsReceptionist": false,
      "needsSpecialty": "researcher",
      "desc": "Untangles Alien DNA. Best staffed by a Doctor with Research training.",
      "staffSlot": {
        "x": 0.28,
        "y": 0.35
      },
      "patientSlot": {
        "x": 0.62,
        "y": 0.55
      },
      "furniture": "machine",
      "machine": "dnaMachine",
      "diagnosisPower": 0,
      "energyCost": 55,
      "decayRate": 4.5
    },
    "hairRestoration": {
      "id": "hairRestoration",
      "name": "Hair Restoration",
      "category": "clinic",
      "color": "#f2ece0",
      "darkColor": "#d4c8ae",
      "minW": 4,
      "minH": 4,
      "maxW": 6,
      "maxH": 6,
      "cost": 1100,
      "capacity": 1,
      "needsDoctor": true,
      "needsReceptionist": false,
      "desc": "Cures Baldness with a fresh head of hair.",
      "staffSlot": {
        "x": 0.3,
        "y": 0.4
      },
      "patientSlot": {
        "x": 0.6,
        "y": 0.55
      },
      "furniture": "machine",
      "machine": "hairMachine",
      "diagnosisPower": 0,
      "energyCost": 30,
      "decayRate": 3
    },
    "slackTongueClinic": {
      "id": "slackTongueClinic",
      "name": "Slack Tongue Clinic",
      "category": "clinic",
      "color": "#f2e6e6",
      "darkColor": "#d4b4b4",
      "minW": 4,
      "minH": 4,
      "maxW": 6,
      "maxH": 6,
      "cost": 1200,
      "capacity": 1,
      "needsDoctor": true,
      "needsReceptionist": false,
      "desc": "Trims an Overlong Tongue back to a manageable length.",
      "staffSlot": {
        "x": 0.3,
        "y": 0.4
      },
      "patientSlot": {
        "x": 0.6,
        "y": 0.55
      },
      "furniture": "machine",
      "machine": "tongueMachine",
      "diagnosisPower": 0,
      "energyCost": 32,
      "decayRate": 3.5
    },
    "fractureClinic": {
      "id": "fractureClinic",
      "name": "Fracture Clinic",
      "category": "clinic",
      "color": "#eef0f4",
      "darkColor": "#c7cdd8",
      "minW": 4,
      "minH": 4,
      "maxW": 6,
      "maxH": 6,
      "cost": 900,
      "capacity": 1,
      "needsDoctor": true,
      "needsNurse": true,
      "needsReceptionist": false,
      "desc": "Sets Fractured Bones. Staffed by a Nurse rather than a Doctor (nurses are the preferred staff here).",
      "staffSlot": {
        "x": 0.3,
        "y": 0.4
      },
      "patientSlot": {
        "x": 0.6,
        "y": 0.55
      },
      "furniture": "bed",
      "diagnosisPower": 0,
      "energyCost": 25,
      "decayRate": 3
    },
    "electrolysis": {
      "id": "electrolysis",
      "name": "Electrolysis",
      "category": "clinic",
      "color": "#eef2e0",
      "darkColor": "#cdd4ae",
      "minW": 4,
      "minH": 4,
      "maxW": 6,
      "maxH": 6,
      "cost": 1250,
      "capacity": 1,
      "needsDoctor": true,
      "needsReceptionist": false,
      "desc": "Zaps away Hairyitis.",
      "staffSlot": {
        "x": 0.3,
        "y": 0.4
      },
      "patientSlot": {
        "x": 0.6,
        "y": 0.55
      },
      "furniture": "machine",
      "machine": "electrolysisMachine",
      "diagnosisPower": 0,
      "energyCost": 34,
      "decayRate": 3.5
    },
    "jellyVat": {
      "id": "jellyVat",
      "name": "Jelly Vat",
      "category": "clinic",
      "color": "#f0e6f2",
      "darkColor": "#cdb4d4",
      "minW": 4,
      "minH": 4,
      "maxW": 6,
      "maxH": 6,
      "cost": 1350,
      "capacity": 1,
      "needsDoctor": true,
      "needsReceptionist": false,
      "desc": "Firms patients back up after Jellyitis.",
      "staffSlot": {
        "x": 0.3,
        "y": 0.4
      },
      "patientSlot": {
        "x": 0.6,
        "y": 0.55
      },
      "furniture": "machine",
      "machine": "jellyMachine",
      "diagnosisPower": 0,
      "energyCost": 34,
      "decayRate": 3.5
    },
    "decontamination": {
      "id": "decontamination",
      "name": "Decontamination",
      "category": "clinic",
      "color": "#eaf2e6",
      "darkColor": "#b9d4ae",
      "minW": 5,
      "minH": 5,
      "maxW": 7,
      "maxH": 7,
      "cost": 2100,
      "capacity": 1,
      "needsDoctor": true,
      "needsReceptionist": false,
      "desc": "Safely strips away Serious Radiation.",
      "staffSlot": {
        "x": 0.3,
        "y": 0.4
      },
      "patientSlot": {
        "x": 0.6,
        "y": 0.55
      },
      "furniture": "machine",
      "machine": "decontaminationMachine",
      "diagnosisPower": 0,
      "energyCost": 48,
      "decayRate": 4.5
    },
    "trainingRoom": {
      "id": "trainingRoom",
      "name": "Training Room",
      "category": "facility",
      "color": "#e6e2f2",
      "darkColor": "#b8b0d4",
      "minW": 4,
      "minH": 4,
      "maxW": 6,
      "maxH": 6,
      "cost": 1400,
      "capacity": 3,
      "needsDoctor": false,
      "needsReceptionist": false,
      "needsConsultant": true,
      "desc": "A Consultant trains other Doctors here, raising their skill over time.",
      "staffSlot": {
        "x": 0.5,
        "y": 0.3
      },
      "patientSlot": {
        "x": 0.5,
        "y": 0.3
      },
      "furniture": "researchDesk",
      "diagnosisPower": 0,
      "energyCost": 25,
      "decayRate": 2
    }
  },
  "machines": {
    "cardiographMachine": {
      "name": "Cardiograph",
      "room": "cardiogram",
      "cost": 2200,
      "maxDurability": 100,
      "breakdownChance": 0.015,
      "repairTime": 25
    },
    "scannerMachine": {
      "name": "Body Scanner",
      "room": "scanner",
      "cost": 6500,
      "maxDurability": 100,
      "breakdownChance": 0.02,
      "repairTime": 40
    },
    "ultrascanMachine": {
      "name": "Ultrascan Unit",
      "room": "ultrascan",
      "cost": 7800,
      "maxDurability": 100,
      "breakdownChance": 0.02,
      "repairTime": 45
    },
    "bloodMachine": {
      "name": "Blood Analyser",
      "room": "bloodMachine",
      "cost": 2600,
      "maxDurability": 100,
      "breakdownChance": 0.015,
      "repairTime": 25
    },
    "xrayMachine": {
      "name": "X-Ray Unit",
      "room": "xray",
      "cost": 7200,
      "maxDurability": 100,
      "breakdownChance": 0.02,
      "repairTime": 40
    },
    "inflationMachine": {
      "name": "Inflator",
      "room": "inflation",
      "cost": 3200,
      "maxDurability": 100,
      "breakdownChance": 0.018,
      "repairTime": 30
    },
    "dnaMachine": {
      "name": "DNA Untangler",
      "room": "dnaFixer",
      "cost": 8800,
      "maxDurability": 100,
      "breakdownChance": 0.025,
      "repairTime": 50
    },
    "hairMachine": {
      "name": "Hair Restorer",
      "room": "hairRestoration",
      "cost": 2400,
      "maxDurability": 100,
      "breakdownChance": 0.015,
      "repairTime": 25
    },
    "tongueMachine": {
      "name": "Tongue Trimmer",
      "room": "slackTongueClinic",
      "cost": 2500,
      "maxDurability": 100,
      "breakdownChance": 0.015,
      "repairTime": 25
    },
    "electrolysisMachine": {
      "name": "Electrolysis Unit",
      "room": "electrolysis",
      "cost": 2700,
      "maxDurability": 100,
      "breakdownChance": 0.018,
      "repairTime": 28
    },
    "jellyMachine": {
      "name": "Jelly Vat",
      "room": "jellyVat",
      "cost": 2900,
      "maxDurability": 100,
      "breakdownChance": 0.018,
      "repairTime": 28
    },
    "decontaminationMachine": {
      "name": "Decontaminator",
      "room": "decontamination",
      "cost": 6800,
      "maxDurability": 100,
      "breakdownChance": 0.022,
      "repairTime": 42
    },
    "deflationMachine": {
      "name": "Deflator",
      "room": "deflation",
      "cost": 3000,
      "maxDurability": 100,
      "breakdownChance": 0.018,
      "repairTime": 30
    },
    "operatingEquipment": {
      "name": "Operating Equipment",
      "room": "operating",
      "cost": 9000,
      "maxDurability": 100,
      "breakdownChance": 0.025,
      "repairTime": 45
    },
    "diagnosticScope": {
      "name": "Diagnostic Scope",
      "room": "diagnostic",
      "cost": 3200,
      "maxDurability": 100,
      "breakdownChance": 0.018,
      "repairTime": 30
    }
  },
  "diseases": {
    "squareNose": {
      "name": "Square Nose Syndrome",
      "severity": 0.2,
      "diagTime": 6,
      "treatTime": 9,
      "cost": 180,
      "reward": 420,
      "room": "pharmacy",
      "symptom": "🟪",
      "diagnosisRequired": 38,
      "healthDecayRate": 0.24,
      "diagnosisDifficulty": 38,
      "contagious": false,
      "cureProbability": 0.9,
      "deathProbability": 0.01,
      "researchCost": 100,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "bigEars": {
      "name": "Oversized Ears",
      "severity": 0.25,
      "diagTime": 7,
      "treatTime": 11,
      "cost": 220,
      "reward": 480,
      "room": "treatment",
      "symptom": "👂",
      "diagnosisRequired": 40,
      "healthDecayRate": 0.3,
      "diagnosisDifficulty": 40,
      "contagious": false,
      "cureProbability": 0.88,
      "deathProbability": 0.013,
      "researchCost": 110,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "hiccupFit": {
      "name": "Chronic Hiccup Fit",
      "severity": 0.15,
      "diagTime": 5,
      "treatTime": 7,
      "cost": 120,
      "reward": 320,
      "room": "pharmacy",
      "symptom": "💧",
      "diagnosisRequired": 36,
      "healthDecayRate": 0.18,
      "diagnosisDifficulty": 36,
      "contagious": false,
      "cureProbability": 0.92,
      "deathProbability": 0.007,
      "researchCost": 90,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "sockFever": {
      "name": "Sock Fever",
      "severity": 0.3,
      "diagTime": 8,
      "treatTime": 12,
      "cost": 260,
      "reward": 520,
      "room": "treatment",
      "symptom": "🧦",
      "diagnosisRequired": 42,
      "healthDecayRate": 0.36,
      "diagnosisDifficulty": 42,
      "contagious": false,
      "cureProbability": 0.86,
      "deathProbability": 0.015,
      "researchCost": 120,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "puffyHead": {
      "name": "Puffy Head",
      "severity": 0.4,
      "diagTime": 9,
      "treatTime": 15,
      "cost": 350,
      "reward": 650,
      "room": "operating",
      "symptom": "🎈",
      "diagnosisRequired": 46,
      "healthDecayRate": 0.48,
      "diagnosisDifficulty": 46,
      "contagious": false,
      "cureProbability": 0.83,
      "deathProbability": 0.02,
      "researchCost": 140,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "wildGiggles": {
      "name": "Uncontrollable Giggles",
      "severity": 0.2,
      "diagTime": 6,
      "treatTime": 8,
      "cost": 150,
      "reward": 360,
      "room": "pharmacy",
      "symptom": "😂",
      "diagnosisRequired": 38,
      "healthDecayRate": 0.24,
      "diagnosisDifficulty": 38,
      "contagious": false,
      "cureProbability": 0.9,
      "deathProbability": 0.01,
      "researchCost": 100,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "longTongue": {
      "name": "Overlong Tongue",
      "severity": 0.35,
      "diagTime": 8,
      "treatTime": 13,
      "cost": 300,
      "reward": 580,
      "room": "treatment",
      "symptom": "👅",
      "diagnosisRequired": 44,
      "healthDecayRate": 0.42,
      "diagnosisDifficulty": 44,
      "contagious": false,
      "cureProbability": 0.85,
      "deathProbability": 0.017,
      "researchCost": 130,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "invertedSight": {
      "name": "Inverted Sight",
      "severity": 0.45,
      "diagTime": 10,
      "treatTime": 16,
      "cost": 400,
      "reward": 720,
      "room": "operating",
      "symptom": "🙃",
      "diagnosisRequired": 48,
      "healthDecayRate": 0.54,
      "diagnosisDifficulty": 48,
      "contagious": false,
      "cureProbability": 0.81,
      "deathProbability": 0.023,
      "researchCost": 150,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "brokenWind": {
      "name": "Broken Wind",
      "severity": 0.12,
      "diagTime": 5,
      "treatTime": 6,
      "cost": 130,
      "reward": 320,
      "room": "pharmacy",
      "symptom": "💨",
      "diagnosisRequired": 35,
      "healthDecayRate": 0.15,
      "desc": "Looks perfectly normal - thankfully there are no open flames nearby. A pharmacy potion clears it right up.",
      "diagnosisDifficulty": 35,
      "contagious": false,
      "cureProbability": 0.93,
      "deathProbability": 0.006,
      "researchCost": 84,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "chronicNosehair": {
      "name": "Chronic Nosehair",
      "severity": 0.14,
      "diagTime": 5,
      "treatTime": 6,
      "cost": 140,
      "reward": 350,
      "room": "pharmacy",
      "symptom": "👃",
      "diagnosisRequired": 36,
      "healthDecayRate": 0.17,
      "desc": "No visible change - a pharmacy liquid clears the nasal forest completely.",
      "diagnosisDifficulty": 36,
      "contagious": false,
      "cureProbability": 0.92,
      "deathProbability": 0.007,
      "researchCost": 88,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "corrugatedAnkles": {
      "name": "Corrugated Ankles",
      "severity": 0.16,
      "diagTime": 5,
      "treatTime": 7,
      "cost": 150,
      "reward": 375,
      "room": "pharmacy",
      "symptom": "🦶",
      "diagnosisRequired": 36,
      "healthDecayRate": 0.19,
      "desc": "No visible change - a pharmacy drink straightens things out.",
      "diagnosisDifficulty": 36,
      "contagious": false,
      "cureProbability": 0.91,
      "deathProbability": 0.008,
      "researchCost": 92,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "discreteItching": {
      "name": "Discrete Itching",
      "severity": 0.15,
      "diagTime": 5,
      "treatTime": 7,
      "cost": 145,
      "reward": 360,
      "room": "pharmacy",
      "symptom": "🤚",
      "diagnosisRequired": 36,
      "healthDecayRate": 0.18,
      "desc": "Spotted by their inability to stop scratching. A pharmacy vial relieves it.",
      "diagnosisDifficulty": 36,
      "contagious": false,
      "cureProbability": 0.92,
      "deathProbability": 0.007,
      "researchCost": 90,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "gastricEjections": {
      "name": "Gastric Ejections",
      "severity": 0.22,
      "diagTime": 6,
      "treatTime": 7,
      "cost": 185,
      "reward": 460,
      "room": "pharmacy",
      "symptom": "🤮",
      "diagnosisRequired": 39,
      "healthDecayRate": 0.26,
      "desc": "No visible change, but can leave a mess if not treated promptly. Pharmacy medicine stops it.",
      "diagnosisDifficulty": 39,
      "contagious": false,
      "cureProbability": 0.89,
      "deathProbability": 0.011,
      "researchCost": 104,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "gutRot": {
      "name": "Gut Rot",
      "severity": 0.2,
      "diagTime": 6,
      "treatTime": 7,
      "cost": 170,
      "reward": 430,
      "room": "pharmacy",
      "symptom": "🦠",
      "diagnosisRequired": 38,
      "healthDecayRate": 0.24,
      "desc": "No visible cues - a pharmacy solution restores the stomach lining.",
      "diagnosisDifficulty": 38,
      "contagious": false,
      "cureProbability": 0.9,
      "deathProbability": 0.01,
      "researchCost": 100,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "heapedPiles": {
      "name": "Heaped Piles",
      "severity": 0.18,
      "diagTime": 5,
      "treatTime": 7,
      "cost": 160,
      "reward": 400,
      "room": "pharmacy",
      "symptom": "🍑",
      "diagnosisRequired": 37,
      "healthDecayRate": 0.22,
      "desc": "No visible change, though they may prefer to stand. A pharmacy cure sorts out the lumpy posterior.",
      "diagnosisDifficulty": 37,
      "contagious": false,
      "cureProbability": 0.91,
      "deathProbability": 0.009,
      "researchCost": 96,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "invisibility": {
      "name": "Invisibility",
      "severity": 0.3,
      "diagTime": 6,
      "treatTime": 8,
      "cost": 230,
      "reward": 570,
      "room": "pharmacy",
      "symptom": "👻",
      "diagnosisRequired": 42,
      "healthDecayRate": 0.36,
      "desc": "Immediately recognisable by the complete lack of head, torso, arms and legs - just their hat, glasses, cane, watch, and shoes remain visible. A pharmacy visit cures it.",
      "diagnosisDifficulty": 42,
      "contagious": false,
      "cureProbability": 0.86,
      "deathProbability": 0.015,
      "researchCost": 120,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "sleepingIllness": {
      "name": "Sleeping Illness",
      "severity": 0.25,
      "diagTime": 6,
      "treatTime": 8,
      "cost": 200,
      "reward": 500,
      "room": "pharmacy",
      "symptom": "😴",
      "diagnosisRequired": 40,
      "healthDecayRate": 0.3,
      "desc": "No visible change - a pharmacy cure for the chronic desire to fall asleep everywhere.",
      "diagnosisDifficulty": 40,
      "contagious": false,
      "cureProbability": 0.88,
      "deathProbability": 0.013,
      "researchCost": 110,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "theSquits": {
      "name": "The Squits",
      "severity": 0.24,
      "diagTime": 6,
      "treatTime": 7,
      "cost": 195,
      "reward": 490,
      "room": "pharmacy",
      "symptom": "💩",
      "diagnosisRequired": 40,
      "healthDecayRate": 0.29,
      "desc": "No visible change, though frequent bathroom trips (and the odd little puddle) are common. A pharmacy binding-agent mixture firms things up.",
      "diagnosisDifficulty": 40,
      "contagious": false,
      "cureProbability": 0.89,
      "deathProbability": 0.012,
      "researchCost": 108,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "transparency": {
      "name": "Transparency",
      "severity": 0.32,
      "diagTime": 7,
      "treatTime": 8,
      "cost": 240,
      "reward": 600,
      "room": "pharmacy",
      "symptom": "🫥",
      "diagnosisRequired": 43,
      "healthDecayRate": 0.38,
      "desc": "Visually recognisable - torso, head and hands turn transparent, showing the skeleton underneath. A pharmacy nurse's drink of colours restores the faded ones.",
      "diagnosisDifficulty": 43,
      "contagious": false,
      "cureProbability": 0.86,
      "deathProbability": 0.016,
      "researchCost": 124,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "uncommonCold": {
      "name": "Uncommon Cold",
      "severity": 0.17,
      "diagTime": 5,
      "treatTime": 7,
      "cost": 155,
      "reward": 390,
      "room": "pharmacy",
      "symptom": "🤧",
      "diagnosisRequired": 37,
      "healthDecayRate": 0.2,
      "desc": "No visible change - a dose of uncommon cough medicine from the pharmacy cures it.",
      "diagnosisDifficulty": 37,
      "contagious": false,
      "cureProbability": 0.91,
      "deathProbability": 0.009,
      "researchCost": 94,
      "unlockLevel": 1,
      "surgeonsRequired": 0
    },
    "thirdDegreeSideburns": {
      "name": "3rd Degree Sideburns",
      "severity": 0.22,
      "diagTime": 7,
      "treatTime": 10,
      "cost": 210,
      "reward": 440,
      "room": "psychiatric",
      "symptom": "🦔",
      "diagnosisRequired": 40,
      "healthDecayRate": 0.26,
      "desc": "Facial hair with a mind of its own - talked down in the Psychiatric Room.",
      "diagnosisDifficulty": 40,
      "contagious": false,
      "cureProbability": 0.89,
      "deathProbability": 0.011,
      "researchCost": 104,
      "unlockLevel": 1
    },
    "fakeBlood": {
      "name": "Fake Blood",
      "severity": 0.2,
      "diagTime": 6,
      "treatTime": 9,
      "cost": 190,
      "reward": 420,
      "room": "psychiatric",
      "symptom": "🩸",
      "diagnosisRequired": 38,
      "healthDecayRate": 0.24,
      "desc": "An overactive imagination convinces them they're bleeding out. Talked down in the Psychiatric Room.",
      "diagnosisDifficulty": 38,
      "contagious": false,
      "cureProbability": 0.9,
      "deathProbability": 0.01,
      "researchCost": 100,
      "unlockLevel": 1
    },
    "infectiousLaughter": {
      "name": "Infectious Laughter",
      "severity": 0.24,
      "diagTime": 7,
      "treatTime": 10,
      "cost": 220,
      "reward": 460,
      "room": "psychiatric",
      "symptom": "🤣",
      "diagnosisRequired": 40,
      "healthDecayRate": 0.28,
      "desc": "Can't stop laughing, and it's catching. Psychiatric counselling calms it.",
      "diagnosisDifficulty": 40,
      "contagious": false,
      "cureProbability": 0.89,
      "deathProbability": 0.012,
      "researchCost": 108,
      "unlockLevel": 1
    },
    "kingComplex": {
      "name": "King Complex",
      "severity": 0.26,
      "diagTime": 7,
      "treatTime": 11,
      "cost": 235,
      "reward": 480,
      "room": "psychiatric",
      "symptom": "👑",
      "diagnosisRequired": 41,
      "healthDecayRate": 0.3,
      "desc": "Convinced of their own royalty. A course of psychiatry brings them back down to earth.",
      "diagnosisDifficulty": 41,
      "contagious": false,
      "cureProbability": 0.88,
      "deathProbability": 0.013,
      "researchCost": 112,
      "unlockLevel": 1
    },
    "sweatyPalms": {
      "name": "Sweaty Palms",
      "severity": 0.18,
      "diagTime": 6,
      "treatTime": 8,
      "cost": 170,
      "reward": 390,
      "room": "psychiatric",
      "symptom": "💦",
      "diagnosisRequired": 37,
      "healthDecayRate": 0.22,
      "desc": "Chronic nervous sweating, resolved with a little psychiatric confidence-building.",
      "diagnosisDifficulty": 37,
      "contagious": false,
      "cureProbability": 0.91,
      "deathProbability": 0.009,
      "researchCost": 96,
      "unlockLevel": 1
    },
    "tvPersonalities": {
      "name": "TV Personalities",
      "severity": 0.28,
      "diagTime": 8,
      "treatTime": 12,
      "cost": 250,
      "reward": 500,
      "room": "psychiatric",
      "symptom": "📺",
      "diagnosisRequired": 42,
      "healthDecayRate": 0.32,
      "desc": "Believes they are a television celebrity. Psychiatric therapy restores their sense of self.",
      "diagnosisDifficulty": 42,
      "contagious": false,
      "cureProbability": 0.87,
      "deathProbability": 0.014,
      "researchCost": 116,
      "unlockLevel": 1
    },
    "alienDNA": {
      "name": "Alien DNA",
      "severity": 0.42,
      "diagTime": 10,
      "treatTime": 18,
      "cost": 420,
      "reward": 760,
      "room": "dnaFixer",
      "symptom": "👽",
      "diagnosisRequired": 48,
      "healthDecayRate": 0.5,
      "desc": "Extraterrestrial genetic material needs careful untangling in the DNA Fixer.",
      "diagnosisDifficulty": 48,
      "contagious": false,
      "cureProbability": 0.82,
      "deathProbability": 0.021,
      "researchCost": 144,
      "unlockLevel": 2
    },
    "baldness": {
      "name": "Baldness",
      "severity": 0.15,
      "diagTime": 5,
      "treatTime": 9,
      "cost": 160,
      "reward": 380,
      "room": "hairRestoration",
      "symptom": "🦲",
      "diagnosisRequired": 36,
      "healthDecayRate": 0.18,
      "desc": "A full head of hair, restored in the Hair Restoration clinic.",
      "diagnosisDifficulty": 36,
      "contagious": false,
      "cureProbability": 0.92,
      "deathProbability": 0.007,
      "researchCost": 90,
      "unlockLevel": 1
    },
    "bloatyHead": {
      "name": "Bloaty Head",
      "severity": 0.4,
      "diagTime": 9,
      "treatTime": 15,
      "cost": 350,
      "reward": 650,
      "room": "inflation",
      "symptom": "🎈",
      "diagnosisRequired": 46,
      "healthDecayRate": 0.48,
      "desc": "An over-inflated head, gently re-sized in the Inflation Room.",
      "diagnosisDifficulty": 46,
      "contagious": false,
      "cureProbability": 0.83,
      "deathProbability": 0.02,
      "researchCost": 140,
      "unlockLevel": 1
    },
    "fracturedBones": {
      "name": "Fractured Bones",
      "severity": 0.3,
      "diagTime": 6,
      "treatTime": 10,
      "cost": 220,
      "reward": 480,
      "room": "fractureClinic",
      "symptom": "🦴",
      "diagnosisRequired": 40,
      "healthDecayRate": 0.4,
      "desc": "Broken bones set and cast in the Fracture Clinic, no doctor required - just a skilled Nurse.",
      "diagnosisDifficulty": 40,
      "contagious": false,
      "cureProbability": 0.86,
      "deathProbability": 0.015,
      "researchCost": 120,
      "unlockLevel": 1
    },
    "hairyitis": {
      "name": "Hairyitis",
      "severity": 0.2,
      "diagTime": 6,
      "treatTime": 9,
      "cost": 190,
      "reward": 420,
      "room": "electrolysis",
      "symptom": "🐻",
      "diagnosisRequired": 38,
      "healthDecayRate": 0.24,
      "desc": "Uncontrolled body-hair growth, zapped away by Electrolysis.",
      "diagnosisDifficulty": 38,
      "contagious": false,
      "cureProbability": 0.9,
      "deathProbability": 0.01,
      "researchCost": 100,
      "unlockLevel": 1
    },
    "jellyitis": {
      "name": "Jellyitis",
      "severity": 0.34,
      "diagTime": 8,
      "treatTime": 13,
      "cost": 300,
      "reward": 580,
      "room": "jellyVat",
      "symptom": "🍮",
      "diagnosisRequired": 44,
      "healthDecayRate": 0.4,
      "desc": "Turns the patient wobbly all over - firmed back up in the Jelly Vat.",
      "diagnosisDifficulty": 44,
      "contagious": false,
      "cureProbability": 0.85,
      "deathProbability": 0.017,
      "researchCost": 128,
      "unlockLevel": 1
    },
    "seriousRadiation": {
      "name": "Serious Radiation",
      "severity": 0.48,
      "diagTime": 10,
      "treatTime": 17,
      "cost": 450,
      "reward": 820,
      "room": "decontamination",
      "symptom": "☢️",
      "diagnosisRequired": 50,
      "healthDecayRate": 0.55,
      "desc": "Dangerously radioactive - handled carefully in Decontamination.",
      "diagnosisDifficulty": 50,
      "contagious": false,
      "cureProbability": 0.8,
      "deathProbability": 0.024,
      "researchCost": 156,
      "unlockLevel": 2
    },
    "slackTongue": {
      "name": "Slack Tongue",
      "severity": 0.28,
      "diagTime": 7,
      "treatTime": 11,
      "cost": 260,
      "reward": 520,
      "room": "slackTongueClinic",
      "symptom": "👅",
      "diagnosisRequired": 41,
      "healthDecayRate": 0.34,
      "desc": "An excessively long tongue, trimmed at the Slack Tongue Clinic.",
      "diagnosisDifficulty": 41,
      "contagious": false,
      "cureProbability": 0.87,
      "deathProbability": 0.014,
      "researchCost": 116,
      "unlockLevel": 1
    },
    "brokenHeart": {
      "name": "Broken Heart",
      "severity": 0.55,
      "diagTime": 11,
      "treatTime": 22,
      "cost": 520,
      "reward": 950,
      "room": "operating",
      "symptom": "💔",
      "diagnosisRequired": 52,
      "healthDecayRate": 0.62,
      "surgeonsRequired": 2,
      "desc": "Needs a delicate two-surgeon operation to mend.",
      "diagnosisDifficulty": 52,
      "contagious": false,
      "cureProbability": 0.78,
      "deathProbability": 0.048,
      "researchCost": 170,
      "unlockLevel": 2
    },
    "golfStones": {
      "name": "Golf Stones",
      "severity": 0.5,
      "diagTime": 10,
      "treatTime": 20,
      "cost": 480,
      "reward": 880,
      "room": "operating",
      "symptom": "⛳",
      "diagnosisRequired": 50,
      "healthDecayRate": 0.58,
      "surgeonsRequired": 2,
      "desc": "Golf-ball-sized stones, removed by two Surgeons in the Operating Theatre.",
      "diagnosisDifficulty": 50,
      "contagious": false,
      "cureProbability": 0.79,
      "deathProbability": 0.045,
      "researchCost": 160,
      "unlockLevel": 2
    },
    "ironLungs": {
      "name": "Iron Lungs",
      "severity": 0.58,
      "diagTime": 11,
      "treatTime": 23,
      "cost": 540,
      "reward": 980,
      "room": "operating",
      "symptom": "🫁",
      "diagnosisRequired": 53,
      "healthDecayRate": 0.65,
      "surgeonsRequired": 2,
      "desc": "Lungs hardened to iron - a serious two-surgeon procedure.",
      "diagnosisDifficulty": 53,
      "contagious": false,
      "cureProbability": 0.77,
      "deathProbability": 0.049,
      "researchCost": 176,
      "unlockLevel": 2
    },
    "kidneyBeans": {
      "name": "Kidney Beans",
      "severity": 0.46,
      "diagTime": 10,
      "treatTime": 19,
      "cost": 460,
      "reward": 850,
      "room": "operating",
      "symptom": "🫘",
      "diagnosisRequired": 49,
      "healthDecayRate": 0.55,
      "surgeonsRequired": 2,
      "desc": "Bean-shaped growths on the kidneys, removed surgically.",
      "diagnosisDifficulty": 49,
      "contagious": false,
      "cureProbability": 0.81,
      "deathProbability": 0.043,
      "researchCost": 152,
      "unlockLevel": 2
    },
    "rupturedNodules": {
      "name": "Ruptured Nodules",
      "severity": 0.52,
      "diagTime": 10,
      "treatTime": 21,
      "cost": 500,
      "reward": 900,
      "room": "operating",
      "symptom": "🔴",
      "diagnosisRequired": 51,
      "healthDecayRate": 0.6,
      "surgeonsRequired": 2,
      "desc": "Nodules requiring urgent surgical attention.",
      "diagnosisDifficulty": 51,
      "contagious": false,
      "cureProbability": 0.79,
      "deathProbability": 0.046,
      "researchCost": 164,
      "unlockLevel": 2
    },
    "spareRibs": {
      "name": "Spare Ribs",
      "severity": 0.44,
      "diagTime": 9,
      "treatTime": 18,
      "cost": 440,
      "reward": 820,
      "room": "operating",
      "symptom": "🍖",
      "diagnosisRequired": 48,
      "healthDecayRate": 0.52,
      "surgeonsRequired": 2,
      "desc": "An extra set of ribs, carefully removed by two Surgeons.",
      "diagnosisDifficulty": 48,
      "contagious": false,
      "cureProbability": 0.82,
      "deathProbability": 0.042,
      "researchCost": 148,
      "unlockLevel": 2
    },
    "unexpectedSwelling": {
      "name": "Unexpected Swelling",
      "severity": 0.48,
      "diagTime": 10,
      "treatTime": 19,
      "cost": 470,
      "reward": 860,
      "room": "operating",
      "symptom": "🎈",
      "diagnosisRequired": 49,
      "healthDecayRate": 0.56,
      "surgeonsRequired": 2,
      "desc": "Sudden, severe swelling needing a two-surgeon operation.",
      "diagnosisDifficulty": 49,
      "contagious": false,
      "cureProbability": 0.8,
      "deathProbability": 0.044,
      "researchCost": 156,
      "unlockLevel": 2
    }
  },
  "staff": {
    "doctor": {
      "name": "Doctor",
      "color": "#ffffff",
      "accent": "#2f8f8a",
      "salary": 60,
      "cost": 900,
      "symbol": "⚕",
      "skill": 500,
      "rank": "doctor"
    },
    "nurse": {
      "name": "Nurse",
      "color": "#f2e2e8",
      "accent": "#c0703f",
      "salary": 40,
      "cost": 600,
      "symbol": "✚",
      "skill": 420,
      "rank": "nurse"
    },
    "receptionist": {
      "name": "Receptionist",
      "color": "#e9d9f2",
      "accent": "#7c6fb0",
      "salary": 35,
      "cost": 500,
      "symbol": "☎",
      "skill": 300,
      "rank": "receptionist"
    },
    "maintenance": {
      "name": "Janitor",
      "color": "#e6dcc6",
      "accent": "#8fa0ad",
      "salary": 30,
      "cost": 450,
      "symbol": "🔧",
      "skill": 350,
      "rank": "handyman"
    },
    "researcher": {
      "name": "Researcher",
      "color": "#dceee8",
      "accent": "#2f8f8a",
      "salary": 55,
      "cost": 1000,
      "symbol": "🔬",
      "skill": 520,
      "rank": "doctor",
      "specialty": "researcher"
    }
  },
  "research": [
    {
      "id": "advancedTreatment",
      "name": "Advanced Treatment",
      "cost": 120,
      "requires": null,
      "desc": "+8% success chance for every treatment in the hospital."
    },
    {
      "id": "seniorResearchers",
      "name": "Senior Researchers",
      "cost": 220,
      "requires": "advancedTreatment",
      "desc": "+40% research speed for all researchers."
    },
    {
      "id": "deflationRoom",
      "name": "Deflation Room",
      "cost": 320,
      "requires": "seniorResearchers",
      "desc": "Unlocks a specialized room for treating inflated heads."
    },
    {
      "id": "surgicalPrograms",
      "name": "Surgical Programs",
      "cost": 260,
      "requires": "advancedTreatment",
      "desc": "+6% success chance in the Operating Theatre, on top of Advanced Treatment."
    },
    {
      "id": "trainingMethods",
      "name": "Modern Training Methods",
      "cost": 200,
      "requires": "advancedTreatment",
      "desc": "+30% faster skill gains in the Training Room."
    }
  ],
  "events": [
    {
      "id": "influx",
      "text": "A sudden influx of patients has arrived!",
      "weight": 3
    },
    {
      "id": "machineFault",
      "text": "A machine has broken down.",
      "weight": 2
    },
    {
      "id": "bonus",
      "text": "A city grant brings in some extra money!",
      "weight": 2
    },
    {
      "id": "inspector",
      "text": "An inspector is visiting your hospital.",
      "weight": 1
    }
  ]
}`);

const ROOM_TYPES = GAME_DATA.rooms;
const MACHINE_TYPES = GAME_DATA.machines;
const DISEASES = GAME_DATA.diseases;
const DISEASE_KEYS = Object.keys(DISEASES);
const STAFF_TYPES = GAME_DATA.staff;
const RESEARCH_PROJECTS = GAME_DATA.research;
const EVENT_TYPES = GAME_DATA.events;
const ROOM_ORDER = GAME_DATA.config.roomOrder;
const LOCKED_ROOM_ORDER = GAME_DATA.config.lockedRoomOrder; // unlocked dynamically once their research project completes
const ROOM_CATEGORIES = GAME_DATA.config.roomCategories; // category key -> display label, used to group the Build panel
const STAFF_RANKS = GAME_DATA.config.staffRanks; // skill-band -> {minSkill,maxSkill,label}, e.g. 250-799 = "Doctor"
const SPECIALTIES = GAME_DATA.config.specialties; // researcher/psychiatrist/surgeon -> {salarySurcharge,trainingPoints,desc}
const WAITING_ROOM_RANGE = TILE*GAME_DATA.config.waitingRoomRangeTiles; // how close (world units) a waiting room must be to a service room's door to be used

// Given a skill value (1-1000), returns the rank key ("junior"/"doctor"/"consultant") from
// GAME_DATA.config.staffRanks. Structure-only for now: nothing yet changes a staff member's
// rank over time, but room-eligibility / hiring UI can already display the right title.
// Ironic one-liners for the hire browser's candidate profiles (see Game.openHireBrowser),
// grouped by role. A handful per role, since the candidate list itself is deliberately short.
const HIRE_QUIPS = {
  doctor: [
    "Diagnosed a papercut as \"probably fine\" - was right, eventually.",
    "Went to medical school. Mostly remembers the cafeteria.",
    "Believes strongly in the healing power of a confident handshake.",
    "Once cured a cold with sheer force of eye contact.",
    "Keeps a rubber chicken in the desk drawer for \"morale\".",
    "Graduated top of the class. The class had two people.",
  ],
  nurse: [
    "Can find a vein blindfolded. Has never needed to prove it.",
    "Refers to all patients as \"hun\", regardless of age or title.",
    "Once organized a whole ward with a color-coded spreadsheet.",
    "Brings homemade soup on Mondays. It's suspicious. It's also great.",
    "Has strong opinions about the correct way to fold a bandage.",
    "Trained a hamster to recognize a fever. It's on the CV.",
  ],
  maintenance: [
    "Fixed a leaking pipe using only optimism and duct tape.",
    "Claims to have seen things in the ventilation. Won't elaborate.",
    "Owns 40 different wrenches. Uses the same one for everything.",
    "Whistles constantly. No one has identified the tune.",
    "Once repaired a machine that wasn't actually broken. Twice.",
    "Treats every mop like it owes them money.",
  ],
  receptionist: [
    "Can file a form and judge your life choices simultaneously.",
    "Has memorized every extension number except the important ones.",
    "Answers the phone in a voice reserved exclusively for the phone.",
    "Once made a queue of 40 people feel like old friends.",
    "Types 110 words per minute, mostly complaints.",
    "Keeps a stash of mints for patients who \"really need one\".",
  ],
  researcher: [
    "Published a paper nobody understood, including the co-authors.",
    "Believes the answer is always \"more funding\".",
    "Keeps a whiteboard covered in equations no one's allowed to erase.",
    "Once discovered something big. Won't say what. Signed an NDA.",
    "Drinks coffee like it's a load-bearing part of the experiment.",
    "Refers to failed experiments as \"preliminary successes\".",
  ],
};
// Portrait background colors, cycled per candidate slot for a bit of visual variety without
// needing actual artwork - a plain colored circle plus the role's emoji reads fine at this size.
const HIRE_AVATAR_COLORS = ["#e0733f","#4f8fb0","#8fa063","#c0703f","#7c6fb0","#2f8f8a"];
function rankForSkill(skill){
  for(const key in STAFF_RANKS){
    const r = STAFF_RANKS[key];
    if(skill >= r.minSkill && skill <= r.maxSkill) return key;
  }
  return "doctor";
}

// Canonical staff/room compatibility check - single source of truth for hiring auto-assign,
// the room-assignment picker, and the Staff Leave Rooms policy. Actually enforces the
// needsNurse/needsSpecialty/needsConsultant metadata added alongside the new room types,
// instead of everything just falling back to the generic needsDoctor flag.
function roleFitsRoom(staff, def){
  const type = staff.type, specialty = staff.specialty, rank = staff.rank;
  if(type==="maintenance") return !def.needsResearcher; // janitors can home-base almost anywhere except the Research Lab
  if(def.needsReceptionist) return type==="receptionist";
  if(def.needsResearcher) return type==="researcher"; // Research Lab: dedicated researcher type only
  if(def.needsConsultant) return type==="doctor"; // Training Room: any doctor can attend (student OR trainer) - see Game._updateTraining for who actually teaches whom
  if(def.needsSpecialty==="psychiatrist") return type==="doctor" && specialty==="psychiatrist";
  if(def.needsSpecialty==="researcher") return type==="doctor" && specialty==="researcher";
  if(def.surgeonsRequired>1) return type==="doctor"; // Operating Theatre: doctors only (any doctor can scrub in; a Surgeon specialty just performs better, see the treatment success formula)
  if(def.needsNurse && !def.needsDoctor) return type==="nurse";
  if(def.needsNurse) return type==="nurse" || type==="doctor";
  if(def.needsDoctor) return type==="doctor" || type==="nurse"; // nurses can still back up a plain doctor room
  return false;
}

// Player-placeable functional furniture (design doc §9/§10 spirit: drinks & comfort items that
// are actually part of the simulation, not decoration). "range" is in tiles, measured from a
// service room's door.
const OBJECT_TYPES = {
  chair:      { name:"Chair",           cost:40,  symbol:"🪑", range:5, desc:"A close, cheap seat right outside a room - patients use these before searching for a Waiting Room." },
  vending:    { name:"Vending Machine", cost:250, symbol:"🥤", range:6, desc:"Softens the mood/energy hit of standing in line nearby." },
  fountain:   { name:"Water Fountain",  cost:200, symbol:"🚰", range:6, desc:"Same comfort effect as a vending machine, patients' favorite." },
  plant:      { name:"Potted Plant",    cost:80,  symbol:"🌿", range:4, desc:"A small, cheap ambience boost for anyone waiting close by." },
  radiator:   { name:"Radiator",        cost:120, symbol:"🔥", range:4, desc:"Keeps a corridor comfortably warm - too cold or too hot both hurt happiness." },
  bin:        { name:"Litter Bin",      cost:60,  symbol:"🗑️", range:4, desc:"Somewhere for rubbish to go instead of the floor." },
  fireExtinguisher: { name:"Fire Extinguisher", cost:25, symbol:"🧯", range:3, desc:"A safety essential - reduces risk from fire-related mishaps." },
};

/* =========================================================================
   2. UTILITIES
   ========================================================================= */
function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }
function lerp(a,b,t){ return a + (b-a)*t; }
function dist(x1,y1,x2,y2){ return Math.hypot(x2-x1, y2-y1); }
function choice(arr){ return arr[(Math.random()*arr.length)|0]; }
function uid(){ return Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4); }
function fmtMoney(n){ return Math.round(n).toLocaleString("fr-FR"); }
// darkens a room's color proportionally to how run-down it is (condition 0-100) - the visual
// half of the room-decay system, so a neglected room actually looks neglected
function shadeForCondition(hex, condition){
  const c = clamp(condition==null?100:condition, 0, 100);
  const factor = 0.5 + (c/100)*0.5; // 0.5x brightness at condition 0, full brightness at 100
  const n = parseInt(hex.slice(1),16);
  const r = Math.round(((n>>16)&255)*factor), g = Math.round(((n>>8)&255)*factor), b = Math.round((n&255)*factor);
  return "#"+[r,g,b].map(v=>clamp(v,0,255).toString(16).padStart(2,"0")).join("");
}
// Boosts saturation (and optionally shifts lightness) of a hex color - used to make each room
// type's floor/walls read as radically distinct at a glance (design feedback: the original
// palette was too uniformly pastel/muted to tell rooms apart quickly), without having to
// manually rewrite all 27 room types' base color definitions by hand.
function boostColor(hex, satMult, lightDelta){
  const n = parseInt(hex.slice(1),16);
  let r=((n>>16)&255)/255, g=((n>>8)&255)/255, b=(n&255)/255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b);
  let h=0, s=0, l=(max+min)/2;
  if(max!==min){
    const d=max-min;
    s = l>0.5 ? d/(2-max-min) : d/(max+min);
    if(max===r) h=(g-b)/d+(g<b?6:0);
    else if(max===g) h=(b-r)/d+2;
    else h=(r-g)/d+4;
    h/=6;
  }
  // Remaps the original hue into a cool, clinical white/green/blue arc (roughly 150°-225°)
  // instead of leaving it free across the whole color wheel (design feedback: the more vivid
  // palette read as too far from "a real hospital" - this keeps rooms visually distinct from
  // each other, since different base hues still land on different points along the arc, while
  // staying in colors that actually look like they belong in a hospital). Saturation is also
  // capped rather than just multiplied, so it stays clean rather than neon.
  const targetH = (150 + h*75) / 360;
  s = clamp(s*(satMult||1), 0, 0.4);
  l = clamp(l+(lightDelta||0), 0, 1);
  const hue2rgb=(p,q,t)=>{ if(t<0)t+=1; if(t>1)t-=1; if(t<1/6) return p+(q-p)*6*t; if(t<1/2) return q; if(t<2/3) return p+(q-p)*(2/3-t)*6; return p; };
  let r2,g2,b2;
  if(s===0){ r2=g2=b2=l; } else {
    const q = l<0.5? l*(1+s) : l+s-l*s;
    const p = 2*l-q;
    r2=hue2rgb(p,q,targetH+1/3); g2=hue2rgb(p,q,targetH); b2=hue2rgb(p,q,targetH-1/3);
  }
  const toHex=(v)=>clamp(Math.round(v*255),0,255).toString(16).padStart(2,"0");
  return "#"+toHex(r2)+toHex(g2)+toHex(b2);
}

/* =========================================================================
   3. CAMERA
   ========================================================================= */
// Isometric camera - camera.x/y live directly in projected iso-screen pixel space (the same
// space gridToScreen() outputs), exactly as validated in the iso preview. Panning just adjusts
// these two numbers by the touch/mouse delta; zoom is a plain multiplier.
class Camera{
  constructor(){
    const center = gridToScreen(MAP_W/2, MAP_H/2);
    this.x = center.x;
    this.y = center.y;
    this.zoom = 1;
    this.minZoom = 0.5;
    this.maxZoom = 2.4;
    this.vOffset = 40; // small upward screen bias so more of the map is visible below center
  }
  // world position (tile-index * TILE, same units as entity x/y) -> canvas CSS-pixel coords
  worldToScreen(wx, wy, canvas){
    const iso = gridToScreen(wx/TILE, wy/TILE);
    return {
      x: canvas.width/(2*DPR) + (iso.x - this.x) * this.zoom,
      y: canvas.height/(2*DPR) - this.vOffset + (iso.y - this.y) * this.zoom
    };
  }
  // canvas CSS-pixel coords -> world position (tile-index * TILE)
  screenToWorld(sx, sy, canvas){
    const isoX = (sx - canvas.width/(2*DPR)) / this.zoom + this.x;
    const isoY = (sy - (canvas.height/(2*DPR) - this.vOffset)) / this.zoom + this.y;
    const g = screenToGrid(isoX, isoY);
    return { x: g.x*TILE, y: g.y*TILE };
  }
  clampToMap(){
    const corners = [ gridToScreen(0,0), gridToScreen(MAP_W,0), gridToScreen(0,MAP_H), gridToScreen(MAP_W,MAP_H) ];
    const xs = corners.map(c=>c.x), ys = corners.map(c=>c.y);
    const pad = 140;
    this.x = clamp(this.x, Math.min(...xs)-pad, Math.max(...xs)+pad);
    this.y = clamp(this.y, Math.min(...ys)-pad, Math.max(...ys)+pad);
  }
}

/* =========================================================================
   4. HOSPITAL GRID
   ========================================================================= */
class Hospital{
  constructor(loadedShape){
    this.rooms = []; // {id, type, x0,y0,x1,y1, x,y,w,h, doorSide, doorFrom, doorTo, staffIds:[], queue:[], ...}
    this.objects = []; // player-placed functional furniture: {id, type, x, y, occupiedBy}
    this.messes = []; // floor messes from untreated GI diseases: {id, x, y, tileX, tileY, type, age}
    this.blocked = new Set(); // edge-based wall blocking, exactly like the validated iso preview
    // The buildable footprint is a "T" shape rather than the full rectangle (design feedback: a
    // plain square hospital felt too generic/easy to fill edge-to-edge). Randomized per new game
    // (design feedback: the branch doesn't need to be centered, the crossbar can point in any of
    // the 4 directions, sizes vary) - both the bar and the stem are always at least 8 tiles
    // across, per the "no branch narrower than 8 cells" requirement. A reloaded game passes its
    // previously-generated shape back in so existing rooms don't end up outside the footprint.
    if(loadedShape){
      this.bar = loadedShape.bar; this.stem = loadedShape.stem;
      this.entrance = loadedShape.entrance; this.direction = loadedShape.direction;
    } else {
      this._generateShape();
    }
    // Blocks the outer boundary immediately, even before any room is built (addRoom also
    // rebuilds this, but that never runs until at least one room exists otherwise).
    this._rebuildBlocked();
  }
  // Builds a random bar+stem T, in one of 4 orientations (the direction the stem points, which
  // is also where the entrance ends up), with randomized thickness/length and a non-centered
  // stem offset along the bar.
  _generateShape(){
    const margin = 1;
    const direction = ["down","up","left","right"][Math.floor(Math.random()*4)];
    const barThickness = 9 + Math.floor(Math.random()*4);   // 9-12
    const stemThickness = 9 + Math.floor(Math.random()*4);  // 9-12
    const stemLength = 10 + Math.floor(Math.random()*5);    // 10-14
    const ew = 2; // entrance gap width, same as before
    let bar, stem, entrance;
    if(direction==="down" || direction==="up"){
      const barX0=margin, barX1=MAP_W-margin;
      const stemX0 = barX0 + Math.floor(Math.random()*Math.max(1,(barX1-barX0-stemThickness)));
      const stemX1 = stemX0+stemThickness;
      const entX0 = clamp(stemX0+Math.floor((stemThickness-ew)/2), stemX0, stemX1-ew);
      if(direction==="down"){
        const barY0=margin, barY1=barY0+barThickness;
        const stemY0=barY1, stemY1=Math.min(MAP_H-margin, stemY0+stemLength);
        bar={x0:barX0,x1:barX1,y0:barY0,y1:barY1};
        stem={x0:stemX0,x1:stemX1,y0:stemY0,y1:stemY1};
        entrance={axis:"h", x0:entX0, x1:entX0+ew, y0:stemY1, y1:stemY1};
      } else {
        const barY1=MAP_H-margin, barY0=barY1-barThickness;
        const stemY1=barY0, stemY0=Math.max(margin, stemY1-stemLength);
        bar={x0:barX0,x1:barX1,y0:barY0,y1:barY1};
        stem={x0:stemX0,x1:stemX1,y0:stemY0,y1:stemY1};
        entrance={axis:"h", x0:entX0, x1:entX0+ew, y0:stemY0, y1:stemY0};
      }
    } else {
      const barY0=margin, barY1=MAP_H-margin;
      const stemY0 = barY0 + Math.floor(Math.random()*Math.max(1,(barY1-barY0-stemThickness)));
      const stemY1 = stemY0+stemThickness;
      const entY0 = clamp(stemY0+Math.floor((stemThickness-ew)/2), stemY0, stemY1-ew);
      if(direction==="right"){
        const barX0=margin, barX1=barX0+barThickness;
        const stemX0=barX1, stemX1=Math.min(MAP_W-margin, stemX0+stemLength);
        bar={x0:barX0,x1:barX1,y0:barY0,y1:barY1};
        stem={x0:stemX0,x1:stemX1,y0:stemY0,y1:stemY1};
        entrance={axis:"v", y0:entY0, y1:entY0+ew, x0:stemX1, x1:stemX1};
      } else {
        const barX1=MAP_W-margin, barX0=barX1-barThickness;
        const stemX1=barX0, stemX0=Math.max(margin, stemX1-stemLength);
        bar={x0:barX0,x1:barX1,y0:barY0,y1:barY1};
        stem={x0:stemX0,x1:stemX1,y0:stemY0,y1:stemY1};
        entrance={axis:"v", y0:entY0, y1:entY0+ew, x0:stemX0, x1:stemX0};
      }
    }
    this.bar = bar; this.stem = stem; this.entrance = entrance; this.direction = direction;
  }
  // True if the whole rectangle [tx,ty,tx+tw,ty+th) lies inside the T-shaped footprint (bar ∪
  // stem). Generalized for any of the 4 orientations by detecting, at runtime, whether bar/stem
  // are stacked vertically (down/up) or side-by-side horizontally (left/right) from their own
  // shared-edge geometry, rather than hardcoding one specific layout.
  inFootprint(tx,ty,tw,th){
    const x0=tx, y0=ty, x1=tx+tw, y1=ty+th;
    if(x0<0||y0<0||x1>MAP_W||y1>MAP_H) return false;
    const bar=this.bar, stem=this.stem;
    if(bar.y1===stem.y0 || bar.y0===stem.y1){ // stacked vertically
      const topIsBar = bar.y1===stem.y0;
      const topRect = topIsBar? bar: stem, bottomRect = topIsBar? stem: bar;
      // Bug fix: this used to only check the CROSS dimension (x) depending on which vertical
      // band a tile fell in, but never checked that the tile stayed within the shape's actual
      // top/bottom extent. Since the stem's length is now randomized and often doesn't reach
      // all the way to the map edge, the leftover "dead space" past the stem's real end was
      // incorrectly treated as inside the footprint - floor tiles (and therefore the corridor
      // color) extended past where the walls actually were, and the grass ring around the
      // building shrank accordingly. Explicitly bounding the outer edges here fixes both.
      if(y0 < topRect.y0 || y1 > bottomRect.y1) return false;
      if(y1 > topRect.y1){ if(x0<bottomRect.x0||x1>bottomRect.x1) return false; }
      if(y0 < topRect.y1){ if(x0<topRect.x0||x1>topRect.x1) return false; }
      return true;
    } else { // side by side horizontally
      const leftIsBar = bar.x1===stem.x0;
      const leftRect = leftIsBar? bar: stem, rightRect = leftIsBar? stem: bar;
      if(x0 < leftRect.x0 || x1 > rightRect.x1) return false; // same fix, other axis
      if(x1 > leftRect.x1){ if(y0<rightRect.y0||y1>rightRect.y1) return false; }
      if(x0 < leftRect.x1){ if(y0<leftRect.y0||y1>leftRect.y1) return false; }
      return true;
    }
  }
  entranceTile(){
    if(this.entrance.axis==="v"){
      const ey = clamp(this.entrance.y0 + Math.floor((this.entrance.y1-this.entrance.y0)/2), this.entrance.y0, this.entrance.y1-1);
      return { x: this.entrance.x0, y: ey };
    }
    const ex = clamp(this.entrance.x0 + Math.floor((this.entrance.x1-this.entrance.x0)/2), this.entrance.x0, this.entrance.x1-1);
    return { x: ex, y: this.entrance.y0 };
  }
  inBounds(x,y){ return x>=0 && y>=0 && x<MAP_W && y<MAP_H; }
  // "walkable" now means "not inside a room's solid interior" (edges handle the fine-grained
  // blocking for pathfinding); still used by a couple of call sites as a coarse open-floor check
  isWalkable(x,y){
    if(!this.inBounds(x,y)) return false;
    const r = this.roomAt(x,y);
    if(!r) return true;
    return this._isDoorTile(r, x, y);
  }
  _isDoorTile(r, x, y){
    if(r.doorSide==="north") return y===r.y0 && x>=r.doorFrom && x<r.doorTo;
    if(r.doorSide==="south") return y===r.y1-1 && x>=r.doorFrom && x<r.doorTo;
    if(r.doorSide==="west") return x===r.x0 && y>=r.doorFrom && y<r.doorTo;
    return x===r.x1-1 && y>=r.doorFrom && y<r.doorTo; // east
  }
  roomAt(x,y){
    for(const r of this.rooms){
      if(x>=r.x0 && x<r.x1 && y>=r.y0 && y<r.y1) return r;
    }
    return null;
  }
  canPlaceRoom(type, tx, ty, tw, th){
    if(tw<=0||th<=0) return {ok:false,reason:"Invalid size"};
    const def = ROOM_TYPES[type];
    if(tw<def.minW || th<def.minH) return {ok:false,reason:"Too small"};
    if(tw>def.maxW || th>def.maxH) return {ok:false,reason:"Too large"};
    if(tx<0||ty<0||tx+tw>MAP_W||ty+th>MAP_H) return {ok:false,reason:"Out of bounds"};
    if(!this.inFootprint(tx,ty,tw,th)) return {ok:false,reason:"Outside the hospital grounds"};
    for(const r of this.rooms){
      if(tx < r.x1 && tx+tw > r.x0 && ty < r.y1 && ty+th > r.y0){
        return {ok:false, reason:"Overlaps another room"};
      }
    }
    return {ok:true};
  }
  addRoom(type, tx, ty, tw, th, doorSide, forceId){
    const id = forceId || uid();
    doorSide = doorSide || "south";
    // door width scales with the room (1-3 tiles), centered on whichever wall was chosen -
    // exactly the door model proven out in the iso preview, now generalized to any side
    let doorFrom, doorTo, doorTileX, doorTileY, doorOutside, doorInsideTile;
    if(doorSide==="north" || doorSide==="south"){
      const doorWidth = 1; // doors are always a single tile wide now
      doorFrom = clamp(tx + Math.floor((tw-doorWidth)/2), tx, tx+tw-doorWidth);
      doorTo = doorFrom+doorWidth;
      doorTileX = clamp(doorFrom + Math.floor((doorTo-doorFrom)/2), doorFrom, doorTo-1);
      if(doorSide==="south"){
        doorInsideTile = {x:doorTileX, y:ty+th-1};
        doorOutside = {x:doorTileX, y:ty+th};
      } else {
        doorInsideTile = {x:doorTileX, y:ty};
        doorOutside = {x:doorTileX, y:ty-1};
      }
    } else {
      const doorWidth = 1;
      doorFrom = clamp(ty + Math.floor((th-doorWidth)/2), ty, ty+th-doorWidth);
      doorTo = doorFrom+doorWidth;
      doorTileY = clamp(doorFrom + Math.floor((doorTo-doorFrom)/2), doorFrom, doorTo-1);
      if(doorSide==="west"){
        doorInsideTile = {x:tx, y:doorTileY};
        doorOutside = {x:tx-1, y:doorTileY};
      } else {
        doorInsideTile = {x:tx+tw-1, y:doorTileY};
        doorOutside = {x:tx+tw, y:doorTileY};
      }
    }
    doorOutside.x = clamp(doorOutside.x, 0, MAP_W-1);
    doorOutside.y = clamp(doorOutside.y, 0, MAP_H-1);
    const room = {
      id, type, x:tx, y:ty, w:tw, h:th, x0:tx, y0:ty, x1:tx+tw, y1:ty+th,
      doorSide, doorFrom, doorTo,
      door: doorOutside,       // representative tile just outside, in the corridor
      doorInside: doorInsideTile, // representative tile just inside, at the threshold
      staffIds:[], queue:[], level:1,
      workers:{}, // slot occupancy
      patientsServed: 0, // how many patients this room has processed, shown when tapped
      condition: 100, // wears down over time; the janitor repairs it. Lower = worse care quality
      // Machine cycle (design doc §17): new -> usage -> durability down -> warning -> breakdown
      // -> handyman -> repair. Separate from `condition` (which is general room upkeep/cleanliness
      // and decays passively every day) - machineDurability only wears from actual USE (each
      // patient served), and a breakdown is a hard stop (machineBroken), not a gradual quality
      // dip. Only meaningful for rooms with a `machine` in GAME_DATA (see ROOM_TYPES[type].machine).
      machineDurability: ROOM_TYPES[type].machine ? 100 : null,
      machineBroken: false,
      lastServedAt: null, // simTime of the last patient successfully served here - null means "never" (see room panel's "time since last patient")
      _constructing: false,
      _constructionTimer: 0,
      _demolishing: false,
      _demolishTimer: 0,
      // Player-added windows on each wall (see the room detail panel's "Customize" section) -
      // purely cosmetic, always starts empty.
      windows: {north:false, south:false, east:false, west:false},
      // Small nudge applied to every furniture piece's normal layout position (see
      // furnitureParts/nudgeRoomFurniture) - lets the player shift the whole arrangement a bit
      // within the room instead of it always sitting in the algorithmically "default" spot.
      furnitureOffset: {dx:0, dy:0},
    };
    // Staff capacity (design feedback: "one room = one staff member" - multiple people sharing
    // a room, scaled by floor area, was confusing to reason about). The only two exceptions are
    // inherently multi-person mechanics documented elsewhere: the Operating Theatre's 2-surgeon
    // team (surgeonsRequired), and the Training Room, which needs a Consultant teaching at
    // least one student at the same time (needsConsultant).
    if(ROOM_TYPES[type].needsDoctor || ROOM_TYPES[type].needsReceptionist || ROOM_TYPES[type].needsResearcher || ROOM_TYPES[type].needsConsultant){
      if(ROOM_TYPES[type].surgeonsRequired>1) room.staffCapacity = 2;
      else if(ROOM_TYPES[type].needsConsultant) room.staffCapacity = 2;
      else room.staffCapacity = 1;
    } else {
      room.staffCapacity = ROOM_TYPES[type].capacity||0;
    }
    if(type==="waitingRoom"){
      // seat count scales with the room's actual built footprint, not a fixed capacity
      room.seatCapacity = Math.max(2, Math.floor((tw*th)/2));
      room.seatedIds = [];
    }
    this.rooms.push(room);
    this._rebuildBlocked();
    return room;
  }
  _blockEdge(x,y,dir){
    this.blocked.add(x+","+y+","+dir);
    if(dir==="N") this.blocked.add(x+","+(y-1)+",S");
    if(dir==="S") this.blocked.add(x+","+(y+1)+",N");
    if(dir==="W") this.blocked.add((x-1)+","+y+",E");
    if(dir==="E") this.blocked.add((x+1)+","+y+",W");
  }
  // True if the edge leaving tile (x,y) in direction dir is the one gap in the outer boundary
  // (the entrance) - used by _rebuildBlocked so that one edge stays open while every other
  // boundary edge gets blocked.
  _isEntranceGap(x, y, dir){
    const ent = this.entrance;
    if(ent.axis==="h"){
      if(dir==="S" && y===ent.y0-1 && x>=ent.x0 && x<ent.x1) return true;
      if(dir==="N" && y===ent.y0 && x>=ent.x0 && x<ent.x1) return true;
    } else {
      if(dir==="E" && x===ent.x0-1 && y>=ent.y0 && y<ent.y1) return true;
      if(dir==="W" && x===ent.x0 && y>=ent.y0 && y<ent.y1) return true;
    }
    return false;
  }
  // rebuilt from scratch on every room added - cheap given room counts stay small, and it
  // keeps the blocking logic identical (and easy to keep in sync) with the iso preview's
  _rebuildBlocked(){
    this.blocked = new Set();
    for(const r of this.rooms){
      for(let x=r.x0;x<r.x1;x++){
        const doorN = r.doorSide==="north" && x>=r.doorFrom && x<r.doorTo;
        if(!doorN) this._blockEdge(x, r.y0, "N");
        const doorS = r.doorSide==="south" && x>=r.doorFrom && x<r.doorTo;
        if(!doorS) this._blockEdge(x, r.y1-1, "S");
      }
      for(let y=r.y0;y<r.y1;y++){
        const doorW = r.doorSide==="west" && y>=r.doorFrom && y<r.doorTo;
        if(!doorW) this._blockEdge(r.x0, y, "W");
        const doorE = r.doorSide==="east" && y>=r.doorFrom && y<r.doorTo;
        if(!doorE) this._blockEdge(r.x1-1, y, "E");
      }
    }
    // Block the outer T-shape boundary too (design feedback: pathfinding could otherwise cut
    // through the "cut corner" grass areas outside the building - since only room walls were
    // ever blocked before, the shortest path between two points sometimes routed straight
    // through the exterior wall, and characters would visibly clip outside the hospital). Every
    // tile inside the footprint gets any edge leading outside it blocked, except the one
    // entrance gap.
    for(let x=0;x<MAP_W;x++){
      for(let y=0;y<MAP_H;y++){
        if(!this.inFootprint(x,y,1,1)) continue;
        if(y===0 || !this.inFootprint(x,y-1,1,1)){ if(!this._isEntranceGap(x,y,"N")) this._blockEdge(x,y,"N"); }
        if(y===MAP_H-1 || !this.inFootprint(x,y+1,1,1)){ if(!this._isEntranceGap(x,y,"S")) this._blockEdge(x,y,"S"); }
        if(x===0 || !this.inFootprint(x-1,y,1,1)){ if(!this._isEntranceGap(x,y,"W")) this._blockEdge(x,y,"W"); }
        if(x===MAP_W-1 || !this.inFootprint(x+1,y,1,1)){ if(!this._isEntranceGap(x,y,"E")) this._blockEdge(x,y,"E"); }
      }
    }
  }
  canMove(x1,y1,x2,y2){
    if(x2<0||y2<0||x2>=MAP_W||y2>=MAP_H) return false;
    const dx=x2-x1, dy=y2-y1;
    const dir = dx===1?"E":dx===-1?"W":dy===1?"S":"N";
    return !this.blocked.has(x1+","+y1+","+dir);
  }
  roomCenterWorld(room){
    return { x:(room.x+room.w/2)*TILE, y:(room.y+room.h/2)*TILE };
  }
  doorWorld(room){
    return { x:(room.door.x+0.5)*TILE, y:(room.door.y+0.5)*TILE };
  }
  doorInsideWorld(room){
    return { x:(room.doorInside.x+0.5)*TILE, y:(room.doorInside.y+0.5)*TILE };
  }
  slotWorld(room, fracKey){
    const def = ROOM_TYPES[room.type];
    const frac = def[fracKey] || {x:0.5,y:0.5};
    return { x:(room.x + room.w*frac.x)*TILE, y:(room.y + room.h*frac.y)*TILE };
  }
  // Multiple staff can now work the same room if it's big enough (room.staffCapacity, computed
  // at construction time). Staff sit in a front row, their paired patients in a row behind them,
  // aligned by the same column index so pairs don't overlap regardless of how many share the room.
  staffSlotWorld(room, index){
    const cap = Math.max(1, room.staffCapacity||1);
    const cols = Math.max(1, Math.ceil(Math.sqrt(cap)));
    const col = index % cols;
    const offset = room.furnitureOffset || {dx:0, dy:0};
    const fx = clamp((col+0.5)/cols+offset.dx, 0.08, 0.92);
    const fy = clamp(0.32+offset.dy, 0.08, 0.92);
    return { x:(room.x + room.w*fx)*TILE, y:(room.y + room.h*fy)*TILE };
  }
  patientSlotWorld(room, index){
    const cap = Math.max(1, room.staffCapacity||1);
    const cols = Math.max(1, Math.ceil(Math.sqrt(cap)));
    const col = index % cols;
    const offset = room.furnitureOffset || {dx:0, dy:0};
    const fx = clamp((col+0.5)/cols+offset.dx, 0.08, 0.92);
    const fy = clamp(0.66+offset.dy, 0.08, 0.92);
    return { x:(room.x + room.w*fx)*TILE, y:(room.y + room.h*fy)*TILE };
  }
  // lowest free staff-slot index in a room, so multiple staff assigned to the same room don't
  // end up stacked on the same desk (same collision-avoidance pattern as waiting-room seating)
  freeStaffSlotIndex(room, staffList, excludeId){
    const cap = Math.max(1, room.staffCapacity||1);
    const used = new Set(staffList.filter(s=>s.assignedRoomId===room.id && s.id!==excludeId).map(s=>s.slotIndex));
    let idx=0;
    while(used.has(idx) && idx<cap) idx++;
    return idx;
  }
  // nearest waiting room with a free seat, within range of a service room's door
  findNearbyWaitingRoom(serviceRoom){
    const doorA = this.doorWorld(serviceRoom);
    let best=null, bestD=Infinity;
    for(const r of this.rooms){
      if(r.type!=="waitingRoom") continue;
      if((r.seatedIds||[]).length >= r.seatCapacity) continue;
      const doorB = this.doorWorld(r);
      const d = Math.hypot(doorA.x-doorB.x, doorA.y-doorB.y);
      if(d <= WAITING_ROOM_RANGE && d<bestD){ bestD=d; best=r; }
    }
    return best;
  }
  // seats arranged in a grid inside the waiting room, count driven by its actual size
  waitingSeatWorld(room, index){
    const cap = room.seatCapacity||2;
    const cols = Math.max(1, Math.ceil(Math.sqrt(cap)));
    const rows = Math.max(1, Math.ceil(cap/cols));
    const col = index % cols, row = Math.floor(index/cols);
    const fx = (col+0.5)/cols, fy = (row+0.5)/rows;
    return { x:(room.x + room.w*fx)*TILE, y:(room.y + room.h*fy)*TILE };
  }
  // world position for the Nth patient standing in line outside a room's door (single file,
  // no seating - people only get seats if a nearby Waiting Room has room for them). The line
  // extends away from the room, in whichever direction the door actually faces.
  // Queue slots widen into a block of 3 across, extending straight out from the door, instead of
  // trailing single-file indefinitely - that used to let a long queue's tail extend far enough
  // to land inside whatever other room happened to be built further down the corridor. Any
  // candidate that still lands inside another room falls back to hugging this room's own door.
  queueSlotWorld(room, index){
    const door = this.doorWorld(room);
    const spacing = 18;
    const dir = { north:{x:0,y:-1}, south:{x:0,y:1}, west:{x:-1,y:0}, east:{x:1,y:0} }[room.doorSide] || {x:0,y:1};
    const perp = { x:-dir.y, y:dir.x };
    const perRow = 3;
    const row = Math.floor(index/perRow);
    const col = (index%perRow) - 1; // -1, 0, 1
    let px = door.x + dir.x*spacing*(row+1) + perp.x*col*spacing*0.85;
    let py = door.y + dir.y*spacing*(row+1) + perp.y*col*spacing*0.85;
    const tx = clamp(Math.floor(px/TILE),0,MAP_W-1), ty = clamp(Math.floor(py/TILE),0,MAP_H-1);
    const occupying = this.roomAt(tx,ty);
    if(occupying && occupying.id!==room.id){
      px = door.x + dir.x*spacing + perp.x*col*spacing*0.5;
      py = door.y + dir.y*spacing + perp.y*col*spacing*0.5;
    }
    return { x:px, y:py };
  }
  roomsOfType(type){ return this.rooms.filter(r=>r.type===type); }

  // ---- player-placed functional furniture (chairs / vending / fountains / plants) ----
  canPlaceObject(tx,ty){
    if(!this.inBounds(tx,ty)) return false;
    if(this.roomAt(tx,ty)) return false; // must sit on open corridor floor, not inside a room
    // keep the entrance clear, whichever wall (and axis) it ended up on
    const inEntranceGap = this.entrance.axis==="v"
      ? (ty>=this.entrance.y0 && ty<this.entrance.y1 && tx===this.entrance.x0)
      : (tx>=this.entrance.x0 && tx<this.entrance.x1 && ty===this.entrance.y0);
    if(inEntranceGap) return false;
    if(this.objects.some(o=>o.x===tx && o.y===ty)) return false;
    return true;
  }
  addObject(type, tx, ty){
    if(!this.canPlaceObject(tx,ty)) return null;
    const obj = { id:uid(), type, x:tx, y:ty, occupiedBy:null };
    this.objects.push(obj);
    return obj;
  }
  removeObject(id){ this.objects = this.objects.filter(o=>o.id!==id); }
  objectWorld(obj){ return { x:(obj.x+0.5)*TILE, y:(obj.y+0.5)*TILE }; }
  // nearest free chair within range of a room's door - the cheap, close alternative to a
  // full Waiting Room; falls back to the waiting-room search if none is close enough
  findNearbyChair(room){
    const door = this.doorWorld(room);
    let best=null, bestD=Infinity;
    for(const o of this.objects){
      if(o.type!=="chair" || o.occupiedBy) continue;
      const ow = this.objectWorld(o);
      const d = Math.hypot(door.x-ow.x, door.y-ow.y);
      if(d <= OBJECT_TYPES.chair.range*TILE && d<bestD){ bestD=d; best=o; }
    }
    return best;
  }
  // how many vending machines / fountains / plants sit within comfort range of a room's door -
  // used to soften the standing-in-line mood/energy penalty, same idea as the old auto-placed
  // props but now the player actually chooses where these go
  nearbyAmenityCount(room, types){
    const door = this.doorWorld(room);
    let count = 0;
    for(const o of this.objects){
      if(!types.includes(o.type)) continue;
      const ow = this.objectWorld(o);
      const range = (OBJECT_TYPES[o.type]?.range||6)*TILE;
      if(Math.hypot(door.x-ow.x, door.y-ow.y) <= range) count++;
    }
    return count;
  }
}

/* =========================================================================
   5. PATHFINDER (edge-based grid BFS - same model validated in the iso preview: walls
      block specific tile-to-tile transitions rather than whole tiles, so pathfinding
      exactly matches what's drawn, including doors of any width)
   ========================================================================= */
const PathFinder = {
  findPath(hospital, sx, sy, tx, ty){
    if(!hospital.inBounds(tx,ty)) return null;
    if(sx===tx && sy===ty) return [{x:sx,y:sy}];
    const key = (x,y)=> y*MAP_W+x;
    const visited = new Set([key(sx,sy)]);
    const prev = new Map();
    const q = [{x:sx,y:sy}];
    let qi=0;
    const dirs=[[1,0],[-1,0],[0,1],[0,-1]];
    let found=false;
    while(qi<q.length){
      const cur=q[qi++];
      if(cur.x===tx && cur.y===ty){ found=true; break; }
      for(const [dx,dy] of dirs){
        const nx=cur.x+dx, ny=cur.y+dy;
        if(!hospital.inBounds(nx,ny)) continue;
        if(!hospital.canMove(cur.x,cur.y,nx,ny)) continue;
        const k=key(nx,ny);
        if(visited.has(k)) continue;
        visited.add(k);
        prev.set(k,cur);
        q.push({x:nx,y:ny});
      }
      if(q.length>2500) break; // safety
    }
    if(!found) return null;
    const path=[{x:tx,y:ty}];
    let ck=key(tx,ty);
    while(ck!==key(sx,sy)){
      const p = prev.get(ck);
      if(!p) break;
      path.push(p);
      ck=key(p.x,p.y);
    }
    path.reverse();
    return path;
  }
};

/* =========================================================================
   6. ENTITIES
   ========================================================================= */
let ENTITY_SEQ=1;

class MovingEntity{
  constructor(x,y){
    this.id = uid();
    this.x = x; this.y = y; // world coords
    this.px = x; this.py = y;
    this.path = null; this.pathIndex = 0;
    this.speed = 55; // px/sec
    this.dir = "down"; // down/up/left/right
    this.animT = Math.random()*10;
    this.idlePhase = Math.random()*10;
    this.moving = false;
    this.z = ENTITY_SEQ++;
  }
  setPathToTile(hospital, tx, ty){
    const sx = Math.floor(this.x/TILE), sy=Math.floor(this.y/TILE);
    const path = PathFinder.findPath(hospital, clamp(sx,0,MAP_W-1), clamp(sy,0,MAP_H-1), tx, ty);
    this.path = path; this.pathIndex=0;
    if(!path) this._pathFailStreak = (this._pathFailStreak||0) + 1;
    else this._pathFailStreak = 0;
    return !!path;
  }
  // Real bug fixed here: a failed pathfind (this.path === null) used to be treated exactly the
  // same as "arrived" (both returned true), so the caller would believe the trip succeeded and
  // advance state while the sprite's x/y never actually moved - the next command would then
  // start fresh from that stale spot, which could look like snapping straight through a wall.
  // Now a null path reports "not done yet" so callers keep retrying instead of falsely advancing.
  updateMovement(dt, speedOverride){
    if(this.path===null){ this.moving=false; return false; }
    if(this.pathIndex>=this.path.length){ this.moving=false; return true; }
    this.moving = true;
    const node = this.path[this.pathIndex];
    const targetX = (node.x+0.5)*TILE, targetY=(node.y+0.5)*TILE;
    const dx=targetX-this.x, dy=targetY-this.y;
    const d = Math.hypot(dx,dy);
    if(Math.abs(dx) > Math.abs(dy)) this.dir = dx>0? "right":"left";
    else this.dir = dy>0? "down":"up";
    const step = (speedOverride||this.speed)*dt;
    if(d <= step){
      this.x = targetX; this.y = targetY;
      this.pathIndex++;
      if(this.pathIndex>=this.path.length){ this.path=null; this.moving=false; return true; }
    } else {
      this.x += dx/d*step; this.y += dy/d*step;
    }
    return false;
  }
  // free (non-grid) direct movement toward a world point - used for queue slots and furniture slots
  // inside a room, where the navigation grid intentionally has no path (interior tiles are blocked)
  // Moves toward a target one grid axis at a time (resolves whichever axis has more distance
  // remaining first, then the other) instead of interpolating a straight Euclidean line across
  // both axes at once. A true grid-diagonal move (x and y changing together) projects onto the
  // iso screen as a flat up/down/left/right slide, breaking the illusion that everything moves
  // along the four proper iso directions - this keeps every visible step iso-cardinal.
  moveToward(tx, ty, dt, speedOverride){
    const dx=tx-this.x, dy=ty-this.y;
    if(Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6){ this.x=tx; this.y=ty; this.moving=false; return true; }
    const sp = speedOverride||this.speed;
    const step = sp*dt;
    this.moving = true;
    if(Math.abs(dx) >= Math.abs(dy)){
      this.dir = dx>0? "right":"left";
      if(Math.abs(dx) <= step){ this.x = tx; } else { this.x += Math.sign(dx)*step; }
    } else {
      this.dir = dy>0? "down":"up";
      if(Math.abs(dy) <= step){ this.y = ty; } else { this.y += Math.sign(dy)*step; }
    }
    if(Math.abs(tx-this.x) < 0.6 && Math.abs(ty-this.y) < 0.6){ this.x=tx; this.y=ty; this.moving=false; return true; }
    return false;
  }
}

class Patient extends MovingEntity{
  constructor(hospital, diseaseKey){
    // everyone arrives through the hospital's single entrance
    const ent = hospital.entranceTile();
    const sx = ent.x, sy = ent.y;
    super((sx+0.5)*TILE, (sy+0.5)*TILE);
    this.kind="patient";
    this.name = choice(["Mia","Marcus","Nina","Theo","Zoe","Hugo","Emma","Leo","Alice","Sam","Jade","Nolan"]);
    this.age = 4+Math.floor(Math.random()*70);
    this.diseaseKey = diseaseKey;
    this.disease = DISEASES[diseaseKey];
    this.health = 100;
    this.happiness = 80;
    this.energy = 100; // drains while standing in line without a seat; recovers while seated
    this.urgency = this.disease.severity;
    this.state = "arriving"; // arriving -> toReception -> queueReception -> toConsult -> queueConsult -> beingConsulted -> toTreatment -> queueTreatment -> beingTreated -> leaving -> gone
    this.stateTimer = 0;
    this.targetRoomId = null;
    this.diagnosed = false;
    this.patience = 100;
    this.speed = 40+Math.random()*15;
    this.arrivedAtSlot = false;   // whether they've reached their furniture slot inside the room
    this.exitAfter = null;        // {type:"toRoom", roomType} or {type:"leave"} - what to do once they've walked back to the door
    this._queueTargetKey = null;  // tracks which tile the queue-line pathfinding is currently aimed at
    // waiting-room / chair seating
    this.seated = false;          // true once physically sitting in a Waiting Room or on a Chair
    this.waitingRoomId = null;
    this.chairObjId = null;
    this.seatIndex = -1;
    this.queueKind = null;        // "queueReception"|"queueConsult"|"queueTreatment" - which line they're logically in
    this.wrPhase = null;          // "toDoor"|"toSeat" while walking into a waiting room
    this.recallRoomId = null;
    this.recallKind = null;
    // diagnosis-progress model (see design doc §2-4): diagnosis is accumulated across visits,
    // not a single dice roll, and health keeps draining the whole time the patient is unwell
    this.diagnosisProgress = 0;
    this.diagnosisAttempts = 0;
    this.diagnosisConfidence = 1; // <1 when treated on a "best guess" after diagnosis attempts run out
    this.priority = false;        // player can bump a patient to the front of their current queue
    this.regTimer = null;         // registration delay at reception, scaled by disease severity
    // thirst (design doc §10, scoped down to just thirst for now): rises over time, satisfied
    // by visiting a nearby fountain; if it maxes out, health starts draining on top of the
    // disease's own decay
    this.thirst = Math.random()*20;
    this.errandType = null;       // "thirst" while on a quick detour to drink
    this.errandStateBefore = null;
    this.errandRoomId = null;     // which room's queue to rejoin (at the front) once the errand ends
    this.errandTargetTile = null; // {x,y} tile of the errand's destination, for path retries
    this.errandTimer = 0;
    this.milkedCount = 0; // how many extra paid "tests" the Diagnosis Termination policy has run
    this.isEmergency = false; // design doc §29 - part of an active Emergency batch (see Game._maybeTriggerEmergency)
    // Operating Theatre 2-surgeon team (design doc §11): the primary worker gets the usual
    // escort choreography via currentPatientId/workPhase; assistingStaffIds holds any additional
    // team members who are occupied for the same procedure but don't do the door-greet walk.
    this.assistingStaffIds = [];
    this._teamSkill = null; // combined team skill snapshot for the current treatment, if any
    this._diagVisited = null; // Set of diagnostic room-type keys already tried (see _pickNextDiagnosticRoomType)
  }
}

class Staff extends MovingEntity{
  constructor(type, x, y, specialty){
    super(x,y);
    this.kind="staff";
    this.type = type; // doctor/nurse/receptionist/maintenance/researcher
    this.def = STAFF_TYPES[type];
    this.name = this.def.name+" "+choice(["Martin","Cole","Rossi","Nkomo","Chen","Garcia","Dubois","Haddad"]);
    // NOTE ON TWO SKILL SCALES: `skill` stays 0-100ish and is what all the existing diagnosis/
    // treatment/speed formulas below already read (see e.g. Game._diagnose/_treat) - left
    // untouched so nothing currently working changes behavior. `skillPoints` is the new,
    // design-doc-accurate 1-1000 scale (§3.3) used only for rank display (Junior/Doctor/
    // Consultant) until a later pass migrates the formulas over to it.
    this.skill = 40+Math.random()*40;
    const base = this.def.skill || 400;
    // Doctors (and researcher-track doctors) roll across the full 1-1000 range so Junior/
    // Doctor/Consultant actually all occur - a Training Room needs the occasional Consultant
    // to show up in the hire pool, matching design doc §3.3. Other roles don't have a
    // Theme-Hospital-documented rank ladder, so they keep the tighter baseline-centered spread.
    this.skillPoints = (type==="doctor"||type==="researcher")
      ? clamp(Math.round(1 + Math.random()*999), 1, 1000)
      : clamp(Math.round(base + (Math.random()*200-100)), 1, 1000);
    this.rank = rankForSkill(this.skillPoints);
    // Optional specialty (researcher/psychiatrist/surgeon, GAME_DATA.config.specialties) - adds
    // a salary surcharge and is required (roleFitsRoom) for Psychiatric/DNA Fixer, and preferred
    // for the Operating Theatre's 2-surgeon team. `researcher`-type hires always carry
    // the researcher specialty for backwards compatibility with the existing Research Lab flow.
    this.specialty = specialty || this.def.specialty || null;
    this.energy = 100;
    this.thirst = Math.random()*20;
    // How workaholic vs break-prone this hire is (see openHireBrowser's candidate profiles,
    // and Game._isDueForRest which actually uses it) - 0 = takes frequent breaks, 100 = rarely
    // stops. Randomized here as a fallback for any staff created outside the hire browser
    // (legacy hireStaff calls, save-file staff, etc); the browser overrides it per candidate.
    this.workEthic = 30+Math.random()*50;
    this.state = "idle"; // idle -> toWork -> enteringRoom -> idle(at slot) -> working -> toRest -> resting
    this.assignedRoomId = null;
    this.stateTimer = 0;
    this.speed = 45+Math.random()*10; // matches patient walking speed (design feedback: staff used to look ~3x too fast)
    this.atSlot = false; // whether they've reached their furniture slot inside the assigned room
    this.slotIndex = 0;  // which desk/bed/bench slot they occupy when a room fits multiple staff
    this.currentPatientId = null;
    // escort choreography while state==="working": toDoor -> atDoor -> toSlot -> atSlot ->
    // seeingOut -> returning -> back to idle. Makes practitioners actually walk to greet and
    // see out each patient instead of standing frozen at their desk the whole time.
    this.workPhase = null;
    this.pendingGreetId = null; // which patient we're walking to the door to greet
    // janitor room-repair errand (maintenance staff only)
    this.repairRoomId = null;
    this.repairTimer = 0;
    this.cleaningMessId = null; // janitor's current mess-cleanup target
    this.fatigueStrain = 0; // builds up while working exhausted (Send Staff to Rest pushed too high); resignation risk
    // Onboarding delay (design feedback: hiring/assignment shouldn't be instant). Set once the
    // player assigns a freshly-hired, still-pending staff member to a room; while true, the
    // "idle" case just counts the timer down instead of walking them to work.
    this.pendingHire = false;
    this.pendingHireTimer = 0;
  }
  // Effective salary including any specialty surcharge (GAME_DATA.config.specialties) and this
  // hire's individual cost multiplier (see openHireBrowser - a more workaholic candidate costs
  // more, both to hire and per day, design feedback: "hourly cost should be tied to
  // productivity").
  get salary(){
    const surcharge = this.specialty && SPECIALTIES[this.specialty] ? SPECIALTIES[this.specialty].salarySurcharge : 0;
    const mult = this.hourlyCostMult!=null ? this.hourlyCostMult : 1;
    return Math.round((this.def.salary||0)*mult) + surcharge;
  }
  get rankLabel(){
    return (STAFF_RANKS[this.rank] && STAFF_RANKS[this.rank].label) || this.def.name;
  }
}

/* =========================================================================
   7. ECONOMY
   ========================================================================= */
class Economy{
  constructor(){
    this.money = 12000;
    this.dailyIncome = 0;
    this.dailyExpense = 0;
    this.totalTreated = 0;
    this.totalFailed = 0;
    this.totalDeaths = 0;
    this.researchPoints = 0;
    this.history = []; // [{day, income, expense}, ...] - for the Manage tab chart
  }
  canAfford(amount){ return this.money >= amount; }
  spend(amount){ this.money -= amount; this.dailyExpense += amount; }
  earn(amount){ this.money += amount; this.dailyIncome += amount; }
  resetDaily(){ this.dailyIncome=0; this.dailyExpense=0; }
}

/* =========================================================================
   7b. ISO WALL / DOOR / DECOR RENDERING PRIMITIVES
   (kept verbatim from the validated iso preview - do not change the visuals)
   ========================================================================= */
function wallQuad(ctx, gx1,gy1, gx2,gy2, color, height){
  height = height || WALL_H;
  const gA = gridToScreen(gx1,gy1), gB = gridToScreen(gx2,gy2);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(gA.x, gA.y); ctx.lineTo(gB.x, gB.y);
  ctx.lineTo(gB.x, gB.y-height); ctx.lineTo(gA.x, gA.y-height);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle="rgba(0,0,0,.18)"; ctx.lineWidth=1; ctx.stroke();
  ctx.strokeStyle="rgba(255,255,255,.25)"; ctx.lineWidth=1.4;
  ctx.beginPath(); ctx.moveTo(gA.x,gA.y-height); ctx.lineTo(gB.x,gB.y-height); ctx.stroke();
}
function drawDoorOnWall(ctx, gx1,gy1, gx2,gy2, height, openAmount){
  // just the frame (posts + lintel) always visible; the leaf itself (below) slides up into the
  // header as someone approaches, instead of swinging - a vertical slide stays trivially
  // correct in this isometric projection without needing perspective-correct rotation math.
  height = height || WALL_H;
  openAmount = clamp(openAmount||0, 0, 1);
  const gA = gridToScreen(gx1,gy1), gB = gridToScreen(gx2,gy2);
  ctx.fillStyle="#5a3d22";
  ctx.fillRect(gA.x-1.5, gA.y-height, 3, height);
  ctx.fillRect(gB.x-1.5, gB.y-height, 3, height);
  ctx.fillStyle="#6b4a2a";
  ctx.beginPath();
  ctx.moveTo(gA.x, gA.y-height); ctx.lineTo(gB.x, gB.y-height);
  ctx.lineTo(gB.x, gB.y-height+6); ctx.lineTo(gA.x, gA.y-height+6);
  ctx.closePath(); ctx.fill();
  const openingH = height-6;
  const leafH = openingH*(1-openAmount);
  if(leafH > 0.6){
    const topOffset = height-6; // fixed at the header, regardless of how open the door is
    ctx.fillStyle = "#8a6239";
    ctx.beginPath();
    ctx.moveTo(gA.x, gA.y-topOffset); ctx.lineTo(gB.x, gB.y-topOffset);
    ctx.lineTo(gB.x, gB.y-topOffset+leafH); ctx.lineTo(gA.x, gA.y-topOffset+leafH);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,.22)"; ctx.lineWidth=1;
    ctx.beginPath();
    ctx.moveTo((gA.x+gB.x)/2, gA.y-topOffset); ctx.lineTo((gA.x+gB.x)/2, gA.y-topOffset+leafH);
    ctx.stroke();
  }
}
function drawHiddenDoorMarker(ctx, gx1,gy1, gx2,gy2){
  const gA = gridToScreen(gx1,gy1), gB = gridToScreen(gx2,gy2);
  const stub = 10;
  ctx.strokeStyle="#5a3d22"; ctx.lineWidth=2.4; ctx.lineCap="round";
  ctx.beginPath(); ctx.moveTo(gA.x,gA.y); ctx.lineTo(gA.x,gA.y-stub); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(gB.x,gB.y); ctx.lineTo(gB.x,gB.y-stub); ctx.stroke();
  ctx.strokeStyle="rgba(90,61,34,.8)"; ctx.lineWidth=2;
  ctx.beginPath(); ctx.moveTo(gA.x,gA.y); ctx.lineTo(gB.x,gB.y); ctx.stroke();
}
function doorGridSpan(r){
  if(r.doorSide==="north") return { gx1:r.doorFrom, gy1:r.y0, gx2:r.doorTo, gy2:r.y0 };
  if(r.doorSide==="south") return { gx1:r.doorFrom, gy1:r.y1, gx2:r.doorTo, gy2:r.y1 };
  if(r.doorSide==="west")  return { gx1:r.x0, gy1:r.doorFrom, gx2:r.x0, gy2:r.doorTo };
  return { gx1:r.x1, gy1:r.doorFrom, gx2:r.x1, gy2:r.doorTo };
}
function wallAnchor(gx1,gy1,gx2,gy2, heightFrac){
  const gA = gridToScreen(gx1,gy1), gB = gridToScreen(gx2,gy2);
  return { x:(gA.x+gB.x)/2, y:(gA.y+gB.y)/2 - WALL_H*heightFrac };
}
function seedHash(str){
  let h=0; for(let i=0;i<str.length;i++) h=(h*31+str.charCodeAt(i))>>>0;
  return h;
}
function drawWallLight(ctx, x, y){
  ctx.save(); ctx.translate(x,y);
  ctx.fillStyle="rgba(255,230,160,.32)"; ctx.beginPath(); ctx.arc(0,0,10,0,Math.PI*2); ctx.fill();
  ctx.fillStyle="#4a4a4a"; ctx.fillRect(-1.4,0,2.8,5);
  ctx.fillStyle="#ffe9a8"; ctx.beginPath(); ctx.arc(0,-2,4,Math.PI,Math.PI*2); ctx.fill();
  ctx.strokeStyle="#c9ab6a"; ctx.lineWidth=1; ctx.beginPath(); ctx.arc(0,-2,4,Math.PI,Math.PI*2); ctx.stroke();
  ctx.restore();
}
function drawWallPainting(ctx, x, y){
  ctx.save(); ctx.translate(x,y);
  ctx.fillStyle="#6b4a2a"; ctx.fillRect(-7,-6.5,14,11.5);
  ctx.fillStyle="#eef2f0"; ctx.fillRect(-5.5,-5,11,8.5);
  ctx.fillStyle="#8fb0c9"; ctx.fillRect(-5.5,-1.2,11,4.7);
  ctx.fillStyle="#5f9e5a"; ctx.beginPath(); ctx.arc(-1.2,-1.6,2.3,0,Math.PI*2); ctx.fill();
  ctx.fillStyle="#e8b13c"; ctx.beginPath(); ctx.arc(3,-3.6,1.4,0,Math.PI*2); ctx.fill();
  ctx.restore();
}
function drawWallXray(ctx, x, y){
  ctx.save(); ctx.translate(x,y);
  ctx.fillStyle="#1c2a33"; ctx.fillRect(-8,-8.5,16,13.5);
  ctx.fillStyle="#dfeaf2"; ctx.fillRect(-6.5,-7,13,10.5);
  ctx.strokeStyle="rgba(60,90,110,.85)"; ctx.lineWidth=1.1; ctx.lineCap="round";
  ctx.beginPath();
  ctx.moveTo(-3,-5); ctx.lineTo(-2.3,2.6);
  ctx.moveTo(0,-6); ctx.lineTo(0.8,3);
  ctx.moveTo(3,-5); ctx.lineTo(3.6,2.4);
  ctx.moveTo(-3,-5); ctx.lineTo(0,-6); ctx.lineTo(3,-5);
  ctx.stroke();
  ctx.restore();
}
// A player-placed window (see Game.toggleRoomWindow / the room detail panel's "Customize"
// section) - a lighter "sky" pane with a cross mullion, frames drawn a bit deeper than the
// other wall decor so it reads as an actual opening rather than a hung object.
function drawWallWindow(ctx, x, y){
  ctx.save(); ctx.translate(x,y);
  ctx.fillStyle="#5a4632"; ctx.fillRect(-9,-9,18,14);
  ctx.fillStyle="#bfe0ee"; ctx.fillRect(-7,-7.3,14,10.6);
  ctx.fillStyle="rgba(255,255,255,.35)"; ctx.fillRect(-7,-7.3,6,10.6);
  ctx.strokeStyle="#5a4632"; ctx.lineWidth=1.3;
  ctx.beginPath(); ctx.moveTo(0,-7.3); ctx.lineTo(0,3.3); ctx.moveTo(-7,-2); ctx.lineTo(7,-2); ctx.stroke();
  ctx.restore();
}
const WALL_DECOR_KINDS = ["light","painting","xray"];
const WALL_DIR_NORTH = (()=>{ const d=Math.hypot(32,16); return [32/d, 16/d]; })();
const WALL_DIR_WEST  = (()=>{ const d=Math.hypot(32,16); return [-32/d, 16/d]; })();
function pushWallDecor(drawables, r, side, a, b){
  if(b<=a) return;
  const mid = a + Math.floor((b-a)/2);
  // A player-added window (see the room detail panel's "Customize" section) always wins over
  // the random light/painting/x-ray pick for that wall - it's a deliberate placement, not
  // ambient decoration.
  const hasWindow = r.windows && r.windows[side];
  const kind = hasWindow ? "window" : WALL_DECOR_KINDS[seedHash(r.id+side+mid) % WALL_DECOR_KINDS.length];
  const drawFn = kind==="window" ? drawWallWindow : kind==="light"? drawWallLight : kind==="painting"? drawWallPainting : drawWallXray;
  const heightFrac = kind==="light"? 0.9 : 0.55;
  // All 4 sides now supported (design feedback: south/east window toggles used to be silent
  // no-ops since only north/west ever actually rendered decor) - south/east only actually get
  // drawn when "Show south/east walls" is on, same condition their plain wall segments already
  // use, so a window there doesn't appear out of nowhere on a wall that isn't itself visible.
  let depth, anchor, dir;
  if(side==="north"){
    depth = mid+0.5+r.y0;
    anchor = wallAnchor(mid, r.y0, mid+1, r.y0, heightFrac);
    dir = WALL_DIR_NORTH;
  } else if(side==="west"){
    depth = r.x0+mid+0.5;
    anchor = wallAnchor(r.x0, mid, r.x0, mid+1, heightFrac);
    dir = WALL_DIR_WEST;
  } else if(side==="south"){
    depth = mid+0.5+r.y1;
    anchor = wallAnchor(mid, r.y1, mid+1, r.y1, heightFrac);
    dir = WALL_DIR_NORTH;
  } else { // east
    depth = r.x1+mid+0.5;
    anchor = wallAnchor(r.x1, mid, r.x1, mid+1, heightFrac);
    dir = WALL_DIR_WEST;
  }
  drawables.push({ depth: depth+0.001, fn:(ctx)=>{
    ctx.save();
    ctx.translate(anchor.x, anchor.y);
    ctx.transform(dir[0],dir[1], 0,-1, 0,0);
    drawFn(ctx, 0, 0);
    ctx.restore();
  }});
}
const HUMANOID_GROUND_OFFSET = 11*1.35;

/* =========================================================================
   7c. ISO FURNITURE
   Each piece is a small set of "parts" positioned at their own fractional spot inside the
   room (not one flat rectangle icon dumped in the middle), so each part gets projected and
   depth-sorted individually - a doctor can correctly stand in front of (or behind) their own
   desk depending on where they are, and multi-staff rooms get one full furniture set per slot.
   ========================================================================= */
function furnitureParts(room, def){
  const parts = [];
  const kind = def.furniture;
  if(!kind) return parts;
  if(kind==="desk" || kind==="machine" || kind==="researchDesk"){
    const cap = Math.max(1, room.staffCapacity||1);
    const cols = Math.max(1, Math.ceil(Math.sqrt(cap)));
    for(let i=0;i<cap;i++){
      const fx = (i%cols+0.5)/cols;
      if(kind==="desk"){
        parts.push({fx, fy:0.26, part:"desk"});
      } else if(kind==="machine"){
        parts.push({fx:clamp(fx-0.1,0.12,0.88), fy:0.3, part:"machine"});
      } else {
        parts.push({fx, fy:0.34, part:"labBench"});
      }
    }
  } else if(kind==="bed"){
    const cap = Math.max(1, room.staffCapacity||1);
    const cols = Math.max(1, Math.ceil(Math.sqrt(cap)));
    for(let i=0;i<cap;i++){
      parts.push({fx:(i%cols+0.5)/cols, fy:0.5, part:"bed"});
    }
  } else if(kind==="operatingTable"){
    parts.push({fx:0.5, fy:0.5, part:"operatingTable"});
  } else if(kind==="sofa"){
    parts.push({fx:0.32, fy:0.5, part:"sofa"});
    parts.push({fx:0.72, fy:0.62, part:"smallTable"});
  } else if(kind==="stalls"){
    const n = Math.max(1, Math.round(room.w/1.6));
    for(let i=0;i<n;i++) parts.push({fx:(i+0.5)/n, fy:0.5, part:"stall"});
  } else if(kind==="waitingSeats"){
    const cap = room.seatCapacity||2;
    const cols = Math.max(1, Math.ceil(Math.sqrt(cap)));
    const rows = Math.max(1, Math.ceil(cap/cols));
    for(let i=0;i<cap;i++){
      parts.push({fx:(i%cols+0.5)/cols, fy:(Math.floor(i/cols)+0.5)/rows, part:"chair"});
    }
  }
  return parts;
}
function drawFurniturePart(ctx, part, x, y){
  ctx.save();
  ctx.translate(x, y);
  switch(part){
    case "desk": {
      ctx.fillStyle="#6b4a2a"; ctx.fillRect(-11,-5,22,10);
      ctx.fillStyle="#523620"; ctx.fillRect(-11,3,22,2);
      ctx.fillStyle="#dfe6ea"; ctx.fillRect(3,-3,6,6);
      break;
    }
    case "chair": {
      ctx.fillStyle="rgba(0,0,0,.15)"; ctx.beginPath(); ctx.ellipse(0,7,5.5,2.2,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle="#8a5a3a"; ctx.fillRect(-4.5,1,9,4); // seat
      ctx.fillStyle="#6b4426"; ctx.fillRect(-4.5,-7,9,2.4); // backrest
      ctx.fillStyle="#5a3a20"; ctx.fillRect(-4.5,-4.6,2,9.6); ctx.fillRect(2.5,-4.6,2,9.6); // legs/sides
      break;
    }
    case "machine": {
      ctx.fillStyle="rgba(0,0,0,.15)"; ctx.beginPath(); ctx.ellipse(0,10,8,2.6,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle="#cfd8de"; ctx.fillRect(-8,-11,16,20);
      ctx.strokeStyle="#8fa0ad"; ctx.lineWidth=1.2; ctx.strokeRect(-8,-11,16,20);
      ctx.fillStyle="#4f8fb0"; ctx.fillRect(-5,-8,10,8);
      ctx.fillStyle="#e8b13c"; ctx.beginPath(); ctx.arc(0,5,1.8,0,Math.PI*2); ctx.fill();
      break;
    }
    case "bed": {
      ctx.fillStyle="rgba(0,0,0,.15)"; ctx.beginPath(); ctx.ellipse(0,9,15,3.2,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle="#e9edf0"; ctx.fillRect(-14,-6,28,15);
      ctx.strokeStyle="#b9c2c9"; ctx.lineWidth=1.2; ctx.strokeRect(-14,-6,28,15);
      ctx.fillStyle="#c0703f"; ctx.fillRect(-14,-6,7,15);
      ctx.fillStyle="#8fa0ad"; ctx.fillRect(-16,-6,3,15);
      break;
    }
    case "operatingTable": {
      ctx.fillStyle="rgba(0,0,0,.15)"; ctx.beginPath(); ctx.ellipse(0,10,17,4,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle="#e3e8ea"; ctx.beginPath(); ctx.ellipse(0,4,17,9,0,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle="#aeb8bd"; ctx.lineWidth=1.3; ctx.stroke();
      ctx.fillStyle="#e8b13c"; ctx.beginPath(); ctx.arc(0,-16,6,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle="#c8952c"; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(0,-10); ctx.lineTo(0,0); ctx.stroke();
      break;
    }
    case "sofa": {
      ctx.fillStyle="rgba(0,0,0,.15)"; ctx.beginPath(); ctx.ellipse(0,10,18,3.4,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle="#c9705c"; ctx.fillRect(-17,-6,34,16);
      ctx.fillStyle="#a85a48"; ctx.fillRect(-17,-6,34,4);
      break;
    }
    case "smallTable": {
      ctx.fillStyle="rgba(0,0,0,.13)"; ctx.beginPath(); ctx.ellipse(0,6,7,2.3,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle="#6b4a2a"; ctx.fillRect(-7,-3,14,9);
      break;
    }
    case "stall": {
      ctx.strokeStyle="#5f6f7a"; ctx.lineWidth=2;
      ctx.strokeRect(-8,-13,16,20);
      break;
    }
    case "labBench": {
      ctx.fillStyle="rgba(0,0,0,.15)"; ctx.beginPath(); ctx.ellipse(0,9,17,3,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle="#3a5e5a"; ctx.fillRect(-16,-6,32,14);
      ctx.fillStyle="#2a4441"; ctx.fillRect(-16,6,32,2);
      ctx.fillStyle="#8fd8cf";
      ctx.beginPath(); ctx.moveTo(-10,-5); ctx.lineTo(-5,-5); ctx.lineTo(-3,2); ctx.lineTo(-12,2); ctx.closePath(); ctx.fill();
      ctx.fillStyle="#e8b13c"; ctx.beginPath(); ctx.arc(5,0,3.5,0,Math.PI*2); ctx.fill();
      break;
    }
  }
  ctx.restore();
}

/* =========================================================================
   8. MAIN GAME
   ========================================================================= */
class Game{
  constructor(){
    this.canvas = document.getElementById("gameCanvas");
    this.ctx = this.canvas.getContext("2d");
    this.camera = new Camera();
    this.hospital = new Hospital();
    this.economy = new Economy();
    this.patients = [];
    this.staff = [];
    this.notifications = [];
    this.simTime = 0;      // seconds of sim time
    this.dayLength = 90;   // seconds per day
    this.day = 1;
    this.speedMult = 1;
    this.paused = true;
    this.hasStartedPlaying = false;
    this.loan = null;
    this.lastTs = 0;
    this.spawnTimer = 12;
    this._buildGrassPattern();
    this.selected = null; // {kind, entity}
    this._staffRoomPickerOpen = null; // staff id whose custom room-picker list is expanded
    this.followTarget = null; // {kind:'staff'|'patient', id} - camera smoothly tracks this entity each frame, see _updateCameraFollow
    this.buildMode = null; // {type}
    this.hireMode = null; // {staffId} - awaiting a tap on a room to place a freshly-hired staff member
    this._speedBeforeHireMode = null; // {paused,speedMult} snapshot to restore once hireMode resolves
    this.buildDrag = null; // {startTileX, startTileY, curTileX, curTileY}
    this.placeMode = null; // {type} - furniture placement mode, tap-to-place
    this.unlockedResearch = new Set();
    this.activeAlerts = new Map();
    this.showPaths = false;
    this.showHiddenWalls = true;
    this.showRoomNames = true;
    // Policy screen (Theme Hospital): three levers the player can tune, each with a real
    // gameplay effect - see _applyDiagnosisTerminationPolicy / the staff idle-rest check /
    // _applyStaffLeaveRoomsPolicy.
    this.policy = {
      diagnosisTermination: 100, // 100-200%: >100 keeps a fully-diagnosed patient for extra paid tests
      staffRestThreshold: 50,    // 0-100: how much tiredness staff tolerate before heading to rest
      staffLeaveRooms: false,    // whether idle staff can be borrowed to help an overloaded room
    };
    this.hospitalReputation = 70; // lightweight stand-in for the design doc's reputation system
    this.floatingTexts = []; // transient "+$420" popups over patients after payment
    this.activeEmergency = null; // design doc §29 - {id,diseaseKey,total,curedCount,timeLeft,timeLimit,reward,patientIds}
    this.objectives = this._defaultObjectives();

    this._initInput();
    this._initUI();
    this._resize();
    window.addEventListener("resize", ()=>this._resize());
  }

  _defaultObjectives(){
    return [
      { id:"money", label:"Reach $20,000", target:20000, get:()=>this.economy.money, done:false, icon:"💰" },
      { id:"treated", label:"Treat 20 patients", target:20, get:()=>this.economy.totalTreated, done:false, icon:"🩺" },
      { id:"rooms", label:"Build 5 rooms", target:5, get:()=>this.hospital.rooms.length, done:false, icon:"🏗" },
      { id:"docs", label:"Have 3 doctors", target:3, get:()=>this.staff.filter(s=>s.type==="doctor").length, done:false, icon:"⚕" },
      { id:"happy", label:"Average mood > 70%", target:70, get:()=>this.avgHappiness(), done:false, icon:"❤️" },
      { id:"research", label:"Unlock 2 research projects", target:2, get:()=>this.unlockedResearch.size, done:false, icon:"🔬" },
    ];
  }

  avgHappiness(){
    const live = this.patients.filter(p=>p.state!=="dead");
    if(live.length===0) return 100;
    let s=0; for(const p of live) s+=p.happiness;
    return Math.round(s/live.length);
  }
  avgHealth(){
    const live = this.patients.filter(p=>p.state!=="dead");
    if(live.length===0) return 100;
    let s=0; for(const p of live) s+=p.health;
    return Math.round(s/live.length);
  }

  /* ---------------- setup / bootstrap rooms ---------------- */
  bootstrapNewGame(){
    this.hospital = new Hospital();
    this.economy = new Economy();
    this.patients = [];
    this.staff = [];
    this.unlockedResearch = new Set();
    this.activeAlerts = new Map();
    this.hospitalReputation = 70;
    this.floatingTexts = [];
    this.activeEmergency = null;
    this.statsHistory = [];
    this.simTime=0; this.day=1; this.spawnTimer=12;
    this.objectives = this._defaultObjectives();

    // The hospital starts completely empty - the player builds their first rooms and hires
    // staff while paused, with no patients arriving yet. Patients only start showing up once
    // the player presses Play for the first time (see the speed-button handler).
    this.hasStartedPlaying = false;
    this.paused = true;
    this.speedMult = 1;

    this._refreshBuildList();
    // The hospital starts genuinely empty (design feedback: pre-placed starter rooms took away
    // the very first decision of the game) - the player picks where everything goes from
    // scratch, within the randomly-generated T-shaped grounds (see Hospital._generateShape), starting from
    // nothing but the entrance.
    this.pushToast("Welcome! Build a Reception first, then hire staff. Press ▶ when ready.", "good");
    this.save();
  }

  loadOrNew(){
    const raw = localStorage.getItem(SAVE_KEY);
    if(raw){
      try{ this._deserialize(JSON.parse(raw)); return true; }catch(e){ console.warn("save corrompue", e); }
    }
    this.bootstrapNewGame();
    return false;
  }

  hasSave(){ return !!localStorage.getItem(SAVE_KEY); }

  save(){
    try{ localStorage.setItem(SAVE_KEY, JSON.stringify(this._serialize())); }catch(e){ console.warn("save failed", e); }
  }

  // Full save as a downloadable, portable JSON file - same shape as the localStorage save, so
  // it's ready to drop into something like Firebase later without any reformatting.
  exportSaveFile(){
    const data = this._serialize();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");
    a.href = url;
    a.download = "wacky-clinic-save-"+stamp+".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    this.pushToast("Save exported.", "good");
  }

  _serialize(){
    return {
      version:1,
      money:this.economy.money,
      totalTreated:this.economy.totalTreated,
      totalFailed:this.economy.totalFailed,
      totalDeaths:this.economy.totalDeaths||0,
      researchPoints:this.economy.researchPoints,
      econHistory:this.economy.history,
      unlockedResearch:[...this.unlockedResearch],
      hospitalReputation:this.hospitalReputation,
      activeEmergency:this.activeEmergency,
      policy:this.policy,
      hasStartedPlaying:this.hasStartedPlaying,
      loan:this.loan,
      statsHistory:this.statsHistory,
      hospitalShape:{ bar:this.hospital.bar, stem:this.hospital.stem, entrance:this.hospital.entrance, direction:this.hospital.direction },
      objects:this.hospital.objects.map(o=>({id:o.id,type:o.type,x:o.x,y:o.y})),
      messes:this.hospital.messes.map(m=>({id:m.id,x:m.x,y:m.y,tileX:m.tileX,tileY:m.tileY,type:m.type,patientId:m.patientId})),
      day:this.day, simTime:this.simTime,
      rooms:this.hospital.rooms.map(r=>({id:r.id,type:r.type,x:r.x,y:r.y,w:r.w,h:r.h,level:r.level,doorSide:r.doorSide,patientsServed:r.patientsServed,condition:r.condition,machineDurability:r.machineDurability,machineBroken:r.machineBroken,_constructing:r._constructing,_constructionTimer:r._constructionTimer,_demolishing:r._demolishing,_demolishTimer:r._demolishTimer,lastServedAt:r.lastServedAt,windows:r.windows,furnitureOffset:r.furnitureOffset})),
      staff:this.staff.map(s=>({id:s.id,type:s.type,name:s.name,x:s.x,y:s.y,skill:s.skill,skillPoints:s.skillPoints,specialty:s.specialty,energy:s.energy,assignedRoomId:s.assignedRoomId,thirst:s.thirst,pendingHire:s.pendingHire,pendingHireTimer:s.pendingHireTimer,workEthic:s.workEthic,hourlyCostMult:s.hourlyCostMult})),
      patients:this.patients.map(p=>({id:p.id,name:p.name,age:p.age,diseaseKey:p.diseaseKey,health:p.health,happiness:p.happiness,x:p.x,y:p.y,state:p.state,diagnosisProgress:p.diagnosisProgress,thirst:p.thirst,isEmergency:p.isEmergency,diagnosed:p.diagnosed,diagnosisConfidence:p.diagnosisConfidence,diagnosisAttempts:p.diagnosisAttempts,milkedCount:p.milkedCount,deadTimer:p.deadTimer}))
    };
  }
  _deserialize(data){
    // A save always carries the T-shape it was generated with (design feedback: the hospital's
    // footprint is now randomized per new game, so reloading must reuse the same shape rather
    // than rolling a new one - otherwise previously-built rooms could end up outside the new
    // footprint, or the outer walls wouldn't line up with them at all).
    this.hospital = new Hospital(data.hospitalShape || null);
    this.economy = new Economy();
    this.economy.money = data.money ?? 12000;
    this.economy.totalTreated = data.totalTreated||0;
    this.economy.totalFailed = data.totalFailed||0;
    this.economy.totalDeaths = data.totalDeaths||0;
    this.economy.researchPoints = data.researchPoints||0;
    this.economy.history = data.econHistory||[];
    this.hospitalReputation = data.hospitalReputation ?? 70;
    this.activeEmergency = data.activeEmergency || null;
    this.policy = data.policy ? { diagnosisTermination:100, staffRestThreshold:50, staffLeaveRooms:false, ...data.policy } : this.policy;
    this.hasStartedPlaying = data.hasStartedPlaying ?? true; // older saves predate this flag - assume already playing
    this.loan = data.loan || null;
    this.statsHistory = data.statsHistory||[];
    this.day = data.day||1;
    this.simTime = data.simTime||0;
    this.staff=[]; this.patients=[];
    this.unlockedResearch = new Set(data.unlockedResearch||[]);
    // re-apply unlock effects (disease/room mutations) so a reloaded save matches its unlocked state
    for(const id of this.unlockedResearch) this._applyResearchEffect(id);
    this.objectives = this._defaultObjectives();

    (data.rooms||[]).forEach(r=>{
      const room = this.hospital.addRoom(r.type, r.x, r.y, r.w, r.h, r.doorSide, r.id);
      room.level = r.level||1;
      room.patientsServed = r.patientsServed||0;
      room.condition = r.condition==null? 100 : r.condition;
      if(r.machineDurability!=null) room.machineDurability = r.machineDurability;
      room.machineBroken = !!r.machineBroken;
      room.lastServedAt = r.lastServedAt==null? null : r.lastServedAt;
      room._constructing = !!r._constructing;
      room._constructionTimer = r._constructionTimer||0;
      room._demolishing = !!r._demolishing;
      room._demolishTimer = r._demolishTimer||0;
      if(r.windows) room.windows = r.windows;
      if(r.furnitureOffset) room.furnitureOffset = r.furnitureOffset;
    });
    (data.objects||[]).forEach(o=>{
      this.hospital.objects.push({ id:o.id, type:o.type, x:o.x, y:o.y, occupiedBy:null });
    });
    (data.messes||[]).forEach(m=>{
      this.hospital.messes.push({ id:m.id, x:m.x, y:m.y, tileX:m.tileX, tileY:m.tileY, type:m.type, age:0, patientId:m.patientId });
    });
    (data.staff||[]).forEach(s=>{
      const st = new Staff(s.type, s.x, s.y, s.specialty||null);
      st.id = s.id; st.name=s.name; st.skill=s.skill; st.energy=s.energy;
      if(s.skillPoints!=null){ st.skillPoints = s.skillPoints; st.rank = rankForSkill(st.skillPoints); }
      st.thirst = s.thirst||0;
      if(s.workEthic!=null) st.workEthic = s.workEthic;
      if(s.hourlyCostMult!=null) st.hourlyCostMult = s.hourlyCostMult;
      st.pendingHire = !!s.pendingHire;
      st.pendingHireTimer = s.pendingHireTimer||0;
      st.assignedRoomId = s.assignedRoomId;
      const room = this.hospital.rooms.find(r=>r.id===s.assignedRoomId);
      if(room && !room.staffIds.includes(st.id)) room.staffIds.push(st.id);
      this.staff.push(st);
    });
    // slot indices are re-derived after all staff are loaded (order-independent, avoids collisions)
    this.staff.forEach(st=>{
      const room = this.hospital.rooms.find(r=>r.id===st.assignedRoomId);
      if(room) st.slotIndex = this.hospital.freeStaffSlotIndex(room, this.staff, st.id);
    });
    (data.patients||[]).forEach(p=>{
      const pat = new Patient(this.hospital, p.diseaseKey);
      pat.id=p.id; pat.name=p.name; pat.age=p.age; pat.health=p.health; pat.happiness=p.happiness;
      pat.diagnosisProgress = p.diagnosisProgress||0;
      pat.diagnosisAttempts = p.diagnosisAttempts||0;
      pat.milkedCount = p.milkedCount||0;
      pat.diagnosed = !!p.diagnosed;
      pat.diagnosisConfidence = p.diagnosisConfidence!=null ? p.diagnosisConfidence : 1;
      pat.thirst = p.thirst||0;
      pat.isEmergency = !!p.isEmergency;
      pat.x=p.x; pat.y=p.y;
      // A lingering body (state "dead", waiting on the janitor - see _patientDies) must stay
      // exactly that after a reload, not get swept into the normal diagnosed/in-progress resume
      // logic below and start walking around again.
      if(p.state==="dead"){
        pat.state = "dead";
        pat.deadTimer = p.deadTimer||1; // already faded in, no need to replay the animation
        this.patients.push(pat);
        return;
      }
      // Resume from roughly where they were instead of restarting the whole visit (design
      // feedback: everyone used to get forced back to "arriving" -> reception on every reload,
      // even a patient who'd already been fully diagnosed and was on their way to be cured).
      // Precise mid-animation states (which exact queue slot, mid-walk position, etc.) aren't
      // worth reconstructing - room queues themselves aren't persisted - so this resumes at the
      // nearest sensible checkpoint: already-diagnosed patients head straight for their
      // treatment room; anyone who'd made diagnostic progress (or already failed an attempt)
      // goes back to the GP rather than re-registering at reception; a patient saved before
      // ever making any progress just starts the visit over, same as before.
      if(pat.diagnosed){
        const target = this.hospital.roomsOfType(pat.disease.room)[0];
        if(target){
          pat.targetRoomId = target.id;
          const door = this.hospital.doorWorld(target);
          pat.setPathToTile(this.hospital, Math.floor(door.x/TILE), Math.floor(door.y/TILE));
          pat.state = "toTreatment";
        } else {
          pat.state = "arriving"; // their treatment room got demolished while the game was closed
        }
      } else if(pat.diagnosisProgress>0 || pat.diagnosisAttempts>0){
        const con = this.hospital.roomsOfType("consultation")[0];
        if(con){
          pat.targetRoomId = con.id;
          const door = this.hospital.doorWorld(con);
          pat.setPathToTile(this.hospital, Math.floor(door.x/TILE), Math.floor(door.y/TILE));
          pat.state = "toConsult";
        } else {
          pat.state = "arriving";
        }
      } else {
        pat.state = "arriving";
      }
      this.patients.push(pat);
    });
    this._refreshBuildList();
    this.pushToast("Game loaded.", "good");
  }

  resetGame(){
    localStorage.removeItem(SAVE_KEY);
    this.bootstrapNewGame();
  }

  /* ---------------- research ---------------- */
  _applyResearchEffect(id){
    if(id==="deflationRoom"){
      DISEASES.puffyHead.room = "deflation";
    }
    // advancedTreatment & seniorResearchers are read directly off unlockedResearch.has(...)
    // wherever their bonus applies, so no state mutation is needed for those two.
  }

  unlockResearch(projectId){
    const proj = RESEARCH_PROJECTS.find(p=>p.id===projectId);
    if(!proj) return;
    if(this.unlockedResearch.has(projectId)){ return; }
    if(proj.requires && !this.unlockedResearch.has(proj.requires)){
      this.pushToast("Prerequisite research required first.", "bad"); return;
    }
    if(this.economy.researchPoints < proj.cost){
      this.pushToast("Not enough research points.", "bad"); return;
    }
    this.economy.researchPoints -= proj.cost;
    this.unlockedResearch.add(projectId);
    this._applyResearchEffect(projectId);
    this.pushToast("Research complete: "+proj.name+"!", "good");
    this._refreshBuildList();
    this._refreshResearchPanel();
    this.save();
  }

  /* ---------------- toasts ---------------- */
  // Replaces the old one-at-a-time fading toast popups with a persistent horizontal ticker
  // banner (design feedback: toasts took up real screen space and disappeared before you could
  // read them all). Every message is kept in messageHistory (tap the banner to see the full
  // log); the banner itself shows them one after another, each scrolling right-to-left, picking
  // up the next queued message as soon as the current one finishes.
  pushToast(text, cls, priority){
    const entry = { text, cls: cls||"", t: this.simTime||0 };
    this.messageHistory = this.messageHistory || [];
    this.messageHistory.unshift(entry);
    if(this.messageHistory.length>200) this.messageHistory.pop();
    this._bannerQueue = this._bannerQueue || [];
    if(priority){
      // Priority messages (design feedback: "not enough money", "someone left without paying",
      // "an inspector is arriving" should show almost immediately) jump the queue AND cut off
      // whatever's currently scrolling, instead of waiting behind however many routine messages
      // are already queued up.
      this._bannerQueue.unshift(entry);
      this._bannerAnimating = false;
    } else {
      this._bannerQueue.push(entry);
    }
    // If messages are arriving faster than the banner can scroll through them (a chaotic
    // moment with lots of alerts), don't make the player sit through a huge backlog just to
    // see what's happening right now - drop the oldest still-queued ones. They're never lost:
    // messageHistory (the full tappable log) keeps everything regardless.
    if(this._bannerQueue.length>15) this._bannerQueue.splice(0, this._bannerQueue.length-15);
    this._advanceBanner();
  }
  _advanceBanner(){
    const banner = document.getElementById("msgBanner");
    const track = document.getElementById("msgBannerTrack");
    if(!banner || !track) return;
    if(this._bannerAnimating) return; // still showing one - animationend will call this again
    const next = (this._bannerQueue||[]).shift();
    if(!next){ banner.classList.remove("show"); return; }
    this._bannerAnimating = true;
    banner.classList.add("show");
    track.innerHTML = "";
    const span = document.createElement("span");
    span.className = next.cls==="bad"?"msgBad":next.cls==="good"?"msgGood":"";
    span.textContent = next.text;
    track.appendChild(span);
    track.classList.remove("scrolling");
    void track.offsetWidth; // force reflow so re-adding the class restarts the CSS animation
    // duration scales gently with message length, so short messages don't flash by unreadably
    // and long ones don't crawl on forever
    const duration = clamp(next.text.length*0.09 + 3, 4, 11);
    track.style.animationDuration = duration+"s";
    track.classList.add("scrolling");
  }
  // Full scrollable log of every message this session, newest first - opened by tapping the
  // ticker banner. Colors match the banner/old toast convention (good=green, bad=red).
  _openMsgHistory(){
    const list = document.getElementById("msgHistoryList");
    list.innerHTML = "";
    const hist = this.messageHistory || [];
    if(hist.length===0){
      list.innerHTML = '<div style="font-size:11.5px;color:#999;padding:14px 4px;text-align:center;">No messages yet.</div>';
    } else {
      hist.forEach(entry=>{
        const secondsAgo = Math.max(0, (this.simTime||0) - entry.t);
        const row = document.createElement("div");
        row.className="statRow";
        const color = entry.cls==="bad" ? "var(--danger)" : entry.cls==="good" ? "var(--leaf)" : "var(--ink)";
        row.innerHTML = `<span class="label">${this._formatAgo(secondsAgo)}</span><b style="color:${color};flex:1;">${entry.text}</b>`;
        list.appendChild(row);
      });
    }
    document.getElementById("panelMsgHistory").classList.add("show");
  }

  // In-app replacement for window.confirm() - native browser dialogs are frequently blocked or
  // silently no-op inside embedded mobile webviews, which made every confirm()-gated action
  // (like demolishing a room) appear to do nothing when tapped.
  showConfirm(message, onConfirm){
    document.getElementById("confirmMessage").textContent = message;
    document.getElementById("confirmModal").classList.add("show");
    const okBtn = document.getElementById("confirmOkBtn");
    const cancelBtn = document.getElementById("confirmCancelBtn");
    const cleanup = ()=>{
      document.getElementById("confirmModal").classList.remove("show");
      okBtn.replaceWith(okBtn.cloneNode(true));
      cancelBtn.replaceWith(cancelBtn.cloneNode(true));
    };
    document.getElementById("confirmOkBtn").addEventListener("click", ()=>{ cleanup(); onConfirm(); }, {once:true});
    document.getElementById("confirmCancelBtn").addEventListener("click", ()=>{ cleanup(); }, {once:true});
  }

  // A bigger decision than a yes/no confirm - pauses the sim (design feedback: these moments,
  // like "we've discovered a new condition we can't treat yet", are meant to genuinely stop the
  // player and ask something important, unlike the lightweight build/hire holds elsewhere) and
  // presents 2-3 labeled choices, each running its own callback. The modal's own dimmed backdrop
  // is the pause indicator here - no separate "⏸ PAUSED" overlay on top of it.
  showChoice(title, message, choices){
    this._speedBeforeChoice = { paused:this.paused, speedMult:this.speedMult };
    this.paused = true;
    document.getElementById("choiceTitle").textContent = title;
    document.getElementById("choiceMessage").textContent = message;
    const btnContainer = document.getElementById("choiceButtons");
    btnContainer.innerHTML = "";
    choices.forEach(c=>{
      const btn = document.createElement("button");
      btn.className = "panelBtn "+(c.cls||"ghost");
      btn.textContent = c.label;
      btn.addEventListener("click", ()=>{
        document.getElementById("choiceModal").classList.remove("show");
        if(this._speedBeforeChoice){
          this.paused = this._speedBeforeChoice.paused;
          this.speedMult = this._speedBeforeChoice.speedMult;
          this._syncPlayPauseBtn();
          this._speedBeforeChoice = null;
        }
        c.action();
      }, {once:true});
      btnContainer.appendChild(btn);
    });
    document.getElementById("choiceModal").classList.add("show");
  }

  /* ---------------- resize ---------------- */
  _resize(){
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio||1, DPR_CAP);
    window.DPR = dpr;
    this.canvas.width = Math.round(w*dpr);
    this.canvas.height = Math.round(h*dpr);
    this.canvas.style.width = w+"px";
    this.canvas.style.height = h+"px";
    this.ctx.setTransform(dpr,0,0,dpr,0,0);
  }

  /* ---------------- input ---------------- */
  _initInput(){
    const canvas = this.canvas;
    let pointers = new Map();
    let dragMode = null; // "pan" | "build"
    let lastPanX=0, lastPanY=0;
    let pinchStartDist = 0, pinchStartZoom=1;
    let tapStart = null;
    let didDrag = false;

    const getTilePos = (clientX, clientY)=>{
      const rect = canvas.getBoundingClientRect();
      const sx = clientX-rect.left, sy = clientY-rect.top;
      const world = this.camera.screenToWorld(sx, sy, this.canvas);
      return { tx: Math.floor(world.x/TILE), ty: Math.floor(world.y/TILE), sx, sy, world };
    };

    const onDown = (id, clientX, clientY)=>{
      pointers.set(id, {x:clientX,y:clientY, startX:clientX, startY:clientY});
      didDrag=false;
      if(pointers.size===1){
        tapStart = {x:clientX,y:clientY,t:performance.now()};
        if(this.buildMode){
          const {tx,ty} = getTilePos(clientX, clientY);
          this.buildDrag = {sx:tx, sy:ty, cx:tx, cy:ty};
          dragMode="build";
        } else {
          dragMode="pan";
        }
        lastPanX=clientX; lastPanY=clientY;
      } else if(pointers.size===2){
        dragMode="pinch";
        const pts=[...pointers.values()];
        pinchStartDist = dist(pts[0].x,pts[0].y,pts[1].x,pts[1].y);
        pinchStartZoom = this.camera.zoom;
      }
    };
    const onMove = (id, clientX, clientY)=>{
      if(!pointers.has(id)) return;
      const p = pointers.get(id);
      const moved = Math.hypot(clientX-p.startX, clientY-p.startY);
      if(moved>6) didDrag = true;
      p.x=clientX; p.y=clientY;

      if(dragMode==="pinch" && pointers.size>=2){
        const pts=[...pointers.values()];
        const d = dist(pts[0].x,pts[0].y,pts[1].x,pts[1].y);
        if(pinchStartDist>0){
          const nz = clamp(pinchStartZoom * (d/pinchStartDist), this.camera.minZoom, this.camera.maxZoom);
          this.camera.zoom = nz;
          this.camera.clampToMap(this.canvas);
        }
      } else if(dragMode==="pan"){
        const dx = clientX-lastPanX, dy = clientY-lastPanY;
        this.camera.x -= dx/this.camera.zoom;
        this.camera.y -= dy/this.camera.zoom;
        this.camera.clampToMap(this.canvas);
        lastPanX=clientX; lastPanY=clientY;
        // Manually panning breaks the camera out of follow mode (design feedback: following a
        // moving patient/staff member is great, but the player still needs to be able to look
        // around freely without fighting the camera snapping back every frame).
        if(this.followTarget) this.followTarget = null;
      } else if(dragMode==="build"){
        const {tx,ty} = getTilePos(clientX, clientY);
        if(this.buildDrag){ this.buildDrag.cx=tx; this.buildDrag.cy=ty; }
      }
    };
    const onUp = (id, clientX, clientY)=>{
      pointers.delete(id);
      if(pointers.size===0){
        if(dragMode==="build" && this.buildMode && this.buildDrag){
          this._prepareBuildConfirm();
        } else if(dragMode==="pan" && !didDrag){
          this._handleTap(clientX, clientY);
        }
        dragMode=null;
      } else if(pointers.size===1){
        // went from pinch/multi back to single - reset pan anchor
        const remaining=[...pointers.values()][0];
        lastPanX=remaining.x; lastPanY=remaining.y;
        dragMode = this.buildMode? "build":"pan";
      }
    };

    canvas.addEventListener("touchstart", e=>{
      e.preventDefault();
      for(const t of e.changedTouches) onDown(t.identifier, t.clientX, t.clientY);
    }, {passive:false});
    canvas.addEventListener("touchmove", e=>{
      e.preventDefault();
      for(const t of e.changedTouches) onMove(t.identifier, t.clientX, t.clientY);
    }, {passive:false});
    canvas.addEventListener("touchend", e=>{
      e.preventDefault();
      for(const t of e.changedTouches) onUp(t.identifier, t.clientX, t.clientY);
    }, {passive:false});
    canvas.addEventListener("touchcancel", e=>{
      for(const t of e.changedTouches) pointers.delete(t.identifier);
    });

    // Mouse (desktop)
    let mouseDown=false;
    canvas.addEventListener("mousedown", e=>{
      mouseDown=true; onDown("mouse", e.clientX, e.clientY);
    });
    window.addEventListener("mousemove", e=>{
      if(mouseDown) onMove("mouse", e.clientX, e.clientY);
    });
    window.addEventListener("mouseup", e=>{
      if(mouseDown){ mouseDown=false; onUp("mouse", e.clientX, e.clientY); }
    });
    canvas.addEventListener("wheel", e=>{
      e.preventDefault();
      const nz = clamp(this.camera.zoom * (e.deltaY<0? 1.1:0.9), this.camera.minZoom, this.camera.maxZoom);
      this.camera.zoom = nz;
      this.camera.clampToMap(this.canvas);
    }, {passive:false});

    document.getElementById("zoomIn").addEventListener("click", ()=>{
      this.camera.zoom = clamp(this.camera.zoom*1.2, this.camera.minZoom, this.camera.maxZoom);
      this.camera.clampToMap(this.canvas);
    });
    document.getElementById("zoomOut").addEventListener("click", ()=>{
      this.camera.zoom = clamp(this.camera.zoom/1.2, this.camera.minZoom, this.camera.maxZoom);
      this.camera.clampToMap(this.canvas);
    });
  }

  _handleTap(clientX, clientY){
    const rect = this.canvas.getBoundingClientRect();
    const sx = clientX-rect.left, sy = clientY-rect.top;
    const world = this.camera.screenToWorld(sx, sy, this.canvas);

    // hire-placement mode: tap a room to assign the freshly-hired, not-yet-started staff member
    if(this.hireMode){
      const tx = Math.floor(world.x/TILE), ty = Math.floor(world.y/TILE);
      const room = this.hospital.roomAt(tx,ty);
      if(room){
        const st = this.staff.find(s=>s.id===this.hireMode.staffId);
        if(st){
          const ok = this.assignStaffToRoom(st.id, room.id);
          if(ok){
            this.pushToast(st.name+" will start in "+CONSTRUCTION_SECONDS+"s.", "good");
            this.hireMode = null;
            this._syncCancelBtn();
            this._resumeAfterHireMode();
          }
          // on failure, assignStaffToRoom already pushed the specific reason as a toast, and
          // hireMode stays active so the player can just tap a different room
        }
      } else {
        this.pushToast("Tap a room to assign them, or Cancel.", null);
      }
      return;
    }

    // furniture placement mode: a tap places the selected item instead of selecting anything
    if(this.placeMode){
      const tx = Math.floor(world.x/TILE), ty = Math.floor(world.y/TILE);
      this._tryPlaceObject(tx, ty);
      return;
    }

    // find nearest entity - patients/practitioners are checked (and win) before rooms, since
    // tapping a person to see their details is the primary interaction. The hit radius is
    // defined in screen pixels and converted through the current zoom, not a fixed world-unit
    // radius, so it stays a comfortable, consistent fingertip target at any zoom level.
    const screenPixelTolerance = 30;
    let best=null, bestD = screenPixelTolerance/this.camera.zoom;
    for(const s of this.staff){
      const d = dist(world.x,world.y,s.x,s.y);
      if(d<bestD){ bestD=d; best={kind:"staff", entity:s}; }
    }
    for(const p of this.patients){
      const d = dist(world.x,world.y,p.x,p.y);
      if(d<bestD){ bestD=d; best={kind:"patient", entity:p}; }
    }
    if(best){ this._openSelection(best); return; }
    // else check room tap
    const tx=Math.floor(world.x/TILE), ty=Math.floor(world.y/TILE);
    const room = this.hospital.roomAt(tx,ty);
    if(room){ this._openRoomInfo(room); return; }

    // Nothing at all was tapped (bare floor/void) - dismiss whatever panel is currently open
    // (Build, Furniture, Staff, etc.), so a stray tap in the play area closes it the way a
    // click-outside-to-dismiss normally works, rather than requiring the explicit ✕.
    this.closeAllPanels();
    this.followTarget = null;
  }

  /* ---------------- furniture placement ---------------- */
  _tryPlaceObject(tx, ty){
    const type = this.placeMode.type;
    const def = OBJECT_TYPES[type];
    if(!this.hospital.canPlaceObject(tx,ty)){
      this.pushToast("Can't place that there.", "bad");
      return;
    }
    if(!this.economy.canAfford(def.cost)){
      this.pushToast("Not enough money!", "bad", true);
      return;
    }
    this.economy.spend(def.cost);
    this.hospital.addObject(type, tx, ty);
    this.pushToast(def.name+" placed.", "good");
    this.save();
  }
  cancelPlaceMode(){
    this.placeMode = null;
    document.getElementById("furniturePlaceBar").classList.remove("show");
    document.querySelectorAll(".furnitureOption").forEach(el=>el.classList.remove("selected"));
    this._syncCancelBtn();
  }

  /* ---------------- build workflow ---------------- */
  _prepareBuildConfirm(){
    const bd = this.buildDrag;
    if(!bd) return;
    const x0=Math.min(bd.sx,bd.cx), x1=Math.max(bd.sx,bd.cx);
    const y0=Math.min(bd.sy,bd.cy), y1=Math.max(bd.sy,bd.cy);
    const w = x1-x0+1, h=y1-y0+1;
    const def = ROOM_TYPES[this.buildMode.type];
    const check = this.hospital.canPlaceRoom(this.buildMode.type, x0,y0,w,h);
    const prevSide = this.pendingBuild? this.pendingBuild.doorSide : "south";
    this.pendingBuild = {type:this.buildMode.type, x:x0,y:y0,w,h, valid:check.ok, reason:check.reason, doorSide:prevSide};
    const bar = document.getElementById("buildConfirmBar");
    bar.classList.add("show");
    document.getElementById("bcTitle").textContent = def.name+" ("+w+"×"+h+")";
    document.getElementById("bcDetail").textContent = check.ok
      ? ("Cost: "+fmtMoney(def.cost)+" $")
      : ("⚠ "+check.reason);
    document.getElementById("bcConfirm").disabled = !check.ok;
    document.getElementById("bcConfirm").style.opacity = check.ok? "1":"0.5";
    document.querySelectorAll(".doorSideBtn").forEach(b=>{
      b.classList.toggle("primary", b.dataset.side===prevSide);
      b.classList.toggle("ghost", b.dataset.side!==prevSide);
    });
  }

  confirmBuild(){
    const pb = this.pendingBuild;
    if(!pb || !pb.valid) return;
    const def = ROOM_TYPES[pb.type];
    if(!this.economy.canAfford(def.cost)){
      this.pushToast("Not enough money!", "bad", true);
      return;
    }
    this.economy.spend(def.cost);
    const newRoom = this.hospital.addRoom(pb.type, pb.x, pb.y, pb.w, pb.h, pb.doorSide);
    // Rooms are usable the instant they're built (design feedback: a construction delay meant
    // staff couldn't be assigned to a brand-new room right away, which was especially painful
    // at the very start of a game when nothing else exists yet to do in the meantime). Demolish
    // still takes a few seconds (see deleteRoom) since that doesn't block anything the player
    // is trying to do.
    this._rebalanceQueuesAfterBuild(newRoom);
    this.pushToast(def.name+" built!", "good");
    this.cancelBuild();
    this.save();
  }

  // When a second room of the same type finishes, patients already stuck waiting at an older,
  // busier room of that type should be able to take advantage of it in real time instead of
  // only ever finding out about it the next time they happen to route through that room type.
  // Only patients not already about to be served (queue index 0) are moved, so nobody who's
  // already next in line gets bumped.
  _rebalanceQueuesAfterBuild(newRoom){
    const type = newRoom.type;
    // Generalized to any staffed/queueable room type (was hardcoded to the original 6) - a
    // second Scanner, Psychiatric Room, or Fracture Clinic now rebalances an overloaded first
    // one exactly the same way a second Pharmacy always did.
    const def = ROOM_TYPES[type];
    if(!def.needsDoctor && !def.needsReceptionist && !def.needsNurse) return;
    const others = this.hospital.roomsOfType(type).filter(r=>r.id!==newRoom.id);
    for(const other of others){
      const waiting = other.queue.slice(1); // leave index 0 (about to be served) alone
      const moveCount = Math.min(Math.floor(waiting.length/2), 5);
      for(let i=0;i<moveCount;i++){
        const pid = waiting[i];
        const p = this.patients.find(x=>x.id===pid);
        if(!p || !p.state || !p.state.startsWith("queue")) continue;
        other.queue = other.queue.filter(id=>id!==pid);
        newRoom.queue.push(pid);
        p.targetRoomId = newRoom.id;
        p._queueTargetKey = null; // force a fresh, safe path to the new room next frame
        p.path = null;
      }
    }
  }
  cancelBuild(){
    this.buildMode=null; this.buildDrag=null; this.pendingBuild=null;
    document.getElementById("buildConfirmBar").classList.remove("show");
    document.querySelectorAll(".roomOption").forEach(el=>el.classList.remove("selected"));
    this._syncCancelBtn();
  }

  /* ---------------- UI wiring ---------------- */
  _initUI(){
    this._refreshBuildList();
    this._refreshFurnitureList();

    // The old inline hire list is gone entirely now - all 5 roles (doctor/nurse/janitor/
    // receptionist/researcher) live in the face-browser hire window (see btnBrowseProfiles /
    // openHireBrowser), so there's nothing left for this list to show.
    const hireList = document.getElementById("hireList");
    hireList.style.display = "none";
    Object.keys(STAFF_TYPES).filter(k=>false).forEach(key=>{
      const def = STAFF_TYPES[key];
      const el = document.createElement("div");
      el.className="roomOption";
      el.style.flexDirection="column";
      el.style.alignItems="stretch";
      const specKeys = key==="doctor" ? Object.keys(SPECIALTIES).filter(s=>s!=="researcher") : [];
      let chosenSpecialty = null;
      const topRow = document.createElement("div");
      topRow.style.cssText="display:flex;align-items:center;gap:10px;width:100%;";
      topRow.innerHTML = `<div class="roomSwatch" style="background:${def.accent}"></div>
        <div class="meta"><b>${def.name}</b><span class="salaryLine">Salary ${def.salary}$/day</span></div>
        <div class="cost costLine">${fmtMoney(def.cost)} $</div>`;
      el.appendChild(topRow);
      if(specKeys.length){
        const specRow = document.createElement("div");
        specRow.style.cssText="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;";
        const salaryLine = topRow.querySelector(".salaryLine");
        const makeChip = (label, specKey)=>{
          const chip = document.createElement("div");
          chip.className = "roomLinkChip";
          chip.textContent = specKey ? `+ ${label} (+${SPECIALTIES[specKey].salarySurcharge}$/day)` : label;
          chip.style.cssText += "font-size:11px;";
          chip.addEventListener("click", (ev)=>{
            ev.stopPropagation();
            chosenSpecialty = specKey;
            specRow.querySelectorAll(".roomLinkChip").forEach(c=>c.style.background="");
            chip.style.background = "rgba(224,115,63,.25)";
            const surcharge = specKey ? SPECIALTIES[specKey].salarySurcharge : 0;
            salaryLine.textContent = "Salary "+(def.salary+surcharge)+"$/day"+(specKey?" ("+specKey+")":"");
          });
          return chip;
        };
        specRow.appendChild(makeChip("General", null));
        specKeys.forEach(sk=> specRow.appendChild(makeChip(sk[0].toUpperCase()+sk.slice(1), sk)));
        el.appendChild(specRow);
        // default the "General" chip to look selected
        specRow.firstChild.style.background = "rgba(224,115,63,.25)";
      }
      topRow.addEventListener("click", ()=>{ this.beginHirePlacement(key, chosenSpecialty); });
      hireList.appendChild(el);
    });

    document.getElementById("btnBuild").addEventListener("click", ()=>this.togglePanel("panelBuild","btnBuild"));
    document.getElementById("btnFurniture").addEventListener("click", ()=>this.togglePanel("panelFurniture","btnFurniture"));
    document.getElementById("btnDirectory").addEventListener("click", ()=>{ this._refreshDirectoryActivePane(); this.togglePanel("panelDirectory","btnDirectory"); });
    document.getElementById("btnRoomTree").addEventListener("click", ()=>{ this.togglePanel("panelRoomTree","btnRoomTree"); if(document.getElementById("panelRoomTree").classList.contains("show")) this._openRoomTree(); });
    this._setupRoomTreePanZoom();
    // Top-level Directory tabs (design feedback: one general window with Staff/Patients/Rooms
    // tabs, instead of separate buttons for each) - each just shows/hides its pane and refreshes it.
    const dirTabs = { dirTabStaff:"dirPaneStaff", dirTabPatients:"dirPanePatients", dirTabRooms:"dirPaneRooms" };
    Object.keys(dirTabs).forEach(tabId=>{
      document.getElementById(tabId).addEventListener("click", ()=>{
        Object.keys(dirTabs).forEach(t=>{
          document.getElementById(t).classList.toggle("active", t===tabId);
          document.getElementById(dirTabs[t]).style.display = t===tabId ? "" : "none";
        });
        this._directoryActiveTab = tabId;
        this._refreshDirectoryActivePane();
      });
    });
    document.getElementById("staffSubTabHire").addEventListener("click", ()=>{
      document.getElementById("staffSubTabHire").classList.add("active");
      document.getElementById("staffSubTabRoster").classList.remove("active");
      document.getElementById("hireList").style.display="";
      document.getElementById("staffRosterWrap").style.display="none";
    });
    document.getElementById("staffSubTabRoster").addEventListener("click", ()=>{
      document.getElementById("staffSubTabRoster").classList.add("active");
      document.getElementById("staffSubTabHire").classList.remove("active");
      document.getElementById("hireList").style.display="none";
      document.getElementById("staffRosterWrap").style.display="";
      this._refreshStaffRoster();
    });
    document.getElementById("staffSortSelect").addEventListener("change", (e)=>{
      this._staffSortKey = e.target.value;
      this._refreshStaffRoster();
    });
    document.getElementById("btnBrowseProfiles").addEventListener("click", ()=>this.openHireBrowser());
    document.querySelectorAll(".hireRoleBtn").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        this._hireBrowserRole = btn.dataset.role;
        this._hireBrowserIndex = 0;
        this._renderHireRoleColumn();
        this._renderHireProfile();
      });
    });
    document.getElementById("hirePrevBtn").addEventListener("click", ()=>{
      const list = this._hireCandidates[this._hireBrowserRole];
      this._hireBrowserIndex = (this._hireBrowserIndex-1+list.length)%list.length;
      this._renderHireProfile();
    });
    document.getElementById("hireNextBtn").addEventListener("click", ()=>{
      const list = this._hireCandidates[this._hireBrowserRole];
      this._hireBrowserIndex = (this._hireBrowserIndex+1)%list.length;
      this._renderHireProfile();
    });
    document.getElementById("hireCancelBtn").addEventListener("click", ()=>{
      document.getElementById("panelHireBrowser").classList.remove("show");
    });
    document.getElementById("hireConfirmBtn").addEventListener("click", ()=>this._hireFromBrowser());
    document.getElementById("patientSortSelect").addEventListener("change", (e)=>{
      this._patientSortKey = e.target.value;
      this._refreshPatientsRoster();
    });
    document.getElementById("roomSortSelect").addEventListener("change", (e)=>{
      this._roomSortKey = e.target.value;
      this._refreshRoomsRoster();
    });
    document.getElementById("btnManage").addEventListener("click", ()=>{ this._refreshManagePanel(); this.togglePanel("panelManage","btnManage"); });
    document.getElementById("btnResearch").addEventListener("click", ()=>{ this._refreshResearchPanel(); this.togglePanel("panelResearchTree","btnResearch"); });
    // Objectives button removed from the header for now (design feedback: not useful enough to
    // take up header space) - the panel/logic itself is left in place in case it comes back.
    document.getElementById("alertsBtn").addEventListener("click", ()=>{ this._refreshAlertsPanel(); document.getElementById("panelAlerts").classList.toggle("show"); });
    document.getElementById("settingsBtn").addEventListener("click", ()=>{ document.getElementById("panelSettings").classList.toggle("show"); });
    document.getElementById("toggleShowPaths").addEventListener("click", (e)=>{
      this.showPaths = !this.showPaths;
      e.currentTarget.classList.toggle("on", this.showPaths);
    });
    document.getElementById("toggleHiddenWalls").addEventListener("click", (e)=>{
      this.showHiddenWalls = !this.showHiddenWalls;
      e.currentTarget.classList.toggle("on", this.showHiddenWalls);
    });
    document.getElementById("toggleRoomNames").addEventListener("click", (e)=>{
      this.showRoomNames = !this.showRoomNames;
      e.currentTarget.classList.toggle("on", this.showRoomNames);
    });

    document.getElementById("mgOpenPolicy").addEventListener("click", ()=>this.togglePanel("panelPolicy","mgOpenPolicy"));
    document.getElementById("mgOpenLoan").addEventListener("click", ()=>{
      this.closeAllPanels();
      this._refreshLoanPanel();
      document.getElementById("panelLoan").classList.add("show");
    });
    document.getElementById("loanAmountSlider").addEventListener("input", ()=>this._refreshLoanQuote());
    document.getElementById("loanTermSlider").addEventListener("input", ()=>this._refreshLoanQuote());
    document.getElementById("loanTakeBtn").addEventListener("click", ()=>{
      const amount = parseInt(document.getElementById("loanAmountSlider").value,10);
      const termDays = parseInt(document.getElementById("loanTermSlider").value,10);
      this.takeLoan(amount, termDays);
      this._refreshLoanPanel();
    });
    document.getElementById("loanPayOffBtn").addEventListener("click", ()=>{
      this.showConfirm("Pay off the remaining loan balance now?", ()=>{ this.payOffLoan(); this._refreshLoanPanel(); });
    });
    const diagSlider = document.getElementById("polDiagSlider");
    const diagVal = document.getElementById("polDiagVal");
    diagSlider.addEventListener("input", ()=>{
      this.policy.diagnosisTermination = parseInt(diagSlider.value,10);
      diagVal.textContent = diagSlider.value+"%";
    });
    const restSlider = document.getElementById("polRestSlider");
    const restVal = document.getElementById("polRestVal");
    restSlider.addEventListener("input", ()=>{
      this.policy.staffRestThreshold = parseInt(restSlider.value,10);
      restVal.textContent = restSlider.value+"%";
    });
    document.getElementById("polLeaveToggle").addEventListener("click", (e)=>{
      this.policy.staffLeaveRooms = !this.policy.staffLeaveRooms;
      e.currentTarget.classList.toggle("on", this.policy.staffLeaveRooms);
    });

    document.querySelectorAll("[data-metric]").forEach(chip=>{
      chip.addEventListener("click", ()=>{
        this.closeAllPanels();
        this._openStatsChart(chip.dataset.metric);
        document.getElementById("panelStatsChart").classList.add("show");
      });
    });

    document.querySelectorAll(".closeX").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        document.getElementById(btn.dataset.close).classList.remove("show");
        // Closing the selection detail panel also releases the camera, so it doesn't keep
        // silently chasing someone with no panel open to explain why.
        if(btn.dataset.close==="panelSelection") this.followTarget = null;
        if(btn.dataset.close==="panelHistory") this._historyOpenFor = null;
      });
    });

    document.getElementById("bcCancel").addEventListener("click", ()=>this.cancelBuild());
    document.getElementById("bcConfirm").addEventListener("click", ()=>this.confirmBuild());
    document.getElementById("fpCancel").addEventListener("click", ()=>this.cancelPlaceMode());
    document.getElementById("cancelModeBtn").addEventListener("click", ()=>{
      if(this.buildMode) this.cancelBuild();
      if(this.placeMode) this.cancelPlaceMode();
      if(this.hireMode) this.cancelHireMode();
    });
    document.getElementById("msgBanner").addEventListener("click", ()=>this._openMsgHistory());
    document.getElementById("msgBannerTrack").addEventListener("animationend", ()=>{
      this._bannerAnimating = false;
      this._advanceBanner();
    });
    document.querySelectorAll(".doorSideBtn").forEach(b=>{
      b.addEventListener("click", ()=>{
        if(!this.pendingBuild) return;
        this.pendingBuild.doorSide = b.dataset.side;
        document.querySelectorAll(".doorSideBtn").forEach(o=>{
          o.classList.toggle("primary", o===b);
          o.classList.toggle("ghost", o!==b);
        });
      });
    });

    document.getElementById("mgSave").addEventListener("click", ()=>{ this.save(); this.pushToast("Game saved.", "good"); });
    document.getElementById("mgReset").addEventListener("click", ()=>{
      this.showConfirm("Reset the game? This action cannot be undone.", ()=>this.resetGame());
    });
    document.getElementById("mgExport").addEventListener("click", ()=>this.exportSaveFile());
    document.getElementById("mgImport").addEventListener("click", ()=>{
      document.getElementById("mgImportFile").click();
    });
    document.getElementById("mgImportFile").addEventListener("change", (e)=>{
      const file = e.target.files && e.target.files[0];
      if(!file) return;
      const reader = new FileReader();
      reader.onload = ()=>{
        try{
          const data = JSON.parse(reader.result);
          this._deserialize(data);
          this.pushToast("Save imported successfully.", "good");
        }catch(err){
          this.pushToast("Couldn't read that file - not a valid save.", "bad");
        }
        e.target.value = ""; // allow re-selecting the same file later
      };
      reader.readAsText(file);
    });

    // Single Play/Pause toggle (design feedback: only one speed - normal 1x - so a 3-button
    // speed picker was pointless; this just flips paused on/off and swaps the icon).
    document.getElementById("playPauseBtn").addEventListener("click", ()=>{
      this.paused = !this.paused;
      this.speedMult = 1;
      this._syncPlayPauseBtn();
      this._syncPauseOverlay();
      if(!this.paused && !this.hasStartedPlaying){
        this.hasStartedPlaying = true;
        this.pushToast("Patients are starting to arrive!", "good");
      }
    });

    // start screen
    document.getElementById("btnContinue").style.display = this.hasSave()? "inline-flex":"none";
    document.getElementById("btnNewGame").addEventListener("click", ()=>{
      this.bootstrapNewGame();
      document.getElementById("startScreen").style.display="none";
    });
    document.getElementById("btnContinue").addEventListener("click", ()=>{
      this.loadOrNew();
      document.getElementById("startScreen").style.display="none";
    });
  }

  togglePanel(id, btnId){
    const willOpen = !document.getElementById(id).classList.contains("show");
    this.closeAllPanels();
    if(willOpen){
      document.getElementById(id).classList.add("show");
      document.getElementById(btnId).classList.add("active");
    }
    if(id!=="panelBuild") this.cancelBuild();
    if(id!=="panelFurniture") this.cancelPlaceMode();
  }
  closeAllPanels(){
    document.querySelectorAll(".panel").forEach(p=>p.classList.remove("show"));
    document.querySelectorAll(".bigBtn").forEach(b=>b.classList.remove("active"));
  }

  _syncCancelBtn(){
    document.getElementById("cancelModeBtn").classList.toggle("show", !!this.buildMode || !!this.placeMode || !!this.hireMode);
  }

  // Only shows the dimmed "⏸ PAUSED" overlay once the game has actually been played (pressed ▶
  // at least once) - design feedback: before that, the whole point of the setup phase is that
  // nothing is running yet, so a "paused" overlay over ordinary building/hiring reads as if
  // something went wrong rather than just being the game's normal pre-start state.
  _syncPauseOverlay(){
    document.getElementById("pauseOverlay").classList.toggle("show", this.paused && this.hasStartedPlaying);
  }
  // Keeps the single Play/Pause button's icon and active state in sync with this.paused -
  // shared by every code path that can change the pause state out from under the button click
  // handler itself (choice modals, hire mode, etc).
  _syncPlayPauseBtn(){
    const btn = document.getElementById("playPauseBtn");
    if(!btn) return;
    btn.textContent = this.paused ? "▶" : "⏸";
    btn.classList.toggle("active", this.paused);
  }

  // Step 1 of hiring (design feedback: shouldn't auto-place someone in a random room). Creates
  // the staff member immediately (cost is spent right away) but marks them `pendingHire` - they
  // stand near the entrance, don't work yet, and won't start their onboarding countdown until
  // the player taps the room to assign them to. The simulation pauses so nothing moves out from
  // under the player while they decide (dimmed overlay only if the game was actually running -
  // see _syncPauseOverlay); whatever speed was running resumes automatically once the room is
  // picked or the hire is cancelled - see _resumeAfterHireMode. The "tap a room" prompt reuses
  // the same small top ✕ Cancel button as build/furniture placement, instead of its own
  // separate bottom message bar - the toast below already says what to do.
  // Shared by both hire entry points (the plain beginHirePlacement flow and the new profile
  // browser below) - actually spends the money, creates the Staff, and either drops them
  // straight into the roster (janitors, who don't need a room) or starts the tap-a-room
  // placement flow. `overrides` lets the browser stamp a specific candidate's name/work-ethic/
  // cost/skill onto the new hire instead of the plain random defaults.
  _finalizeHire(type, specialty, overrides){
    const def = STAFF_TYPES[type];
    // Hire cost also scales with the candidate's cost multiplier (design feedback: a more
    // workaholic/productive hire costs more up front too, not just per day).
    const hireCost = overrides && overrides.hourlyCostMult!=null ? Math.round(def.cost*overrides.hourlyCostMult) : def.cost;
    if(!this.economy.canAfford(hireCost)){ this.pushToast("Not enough money to hire.", "bad", true); return null; }
    this.economy.spend(hireCost);
    const homeRoom = this.hospital.roomsOfType("staffroom")[0] || this.hospital.roomsOfType("reception")[0];
    const pos = homeRoom? this.hospital.roomCenterWorld(homeRoom) : {x:MAP_W*TILE/2,y:MAP_H*TILE/2};
    const st = new Staff(type, pos.x, pos.y, specialty||null);
    if(overrides){
      if(overrides.name) st.name = overrides.name;
      if(overrides.workEthic!=null) st.workEthic = overrides.workEthic;
      if(overrides.hourlyCostMult!=null) st.hourlyCostMult = overrides.hourlyCostMult;
      if(overrides.skillPoints!=null){ st.skillPoints = overrides.skillPoints; st.rank = rankForSkill(st.skillPoints); }
    }
    // Handymen aren't assigned to a specific room at all (design feedback: they patrol the
    // whole hospital on their own, unlike every other role) - skip the room-placement step
    // entirely and just add them straight to the roster, already working.
    if(type==="maintenance"){
      this.staff.push(st);
      this.pushToast(st.name+" hired and is patrolling the hospital.", "good");
      this.save();
      return st;
    }
    st.pendingHire = true;
    this.staff.push(st);
    this.hireMode = {staffId: st.id};
    // Remember exactly how the game was running (paused or which speed) so it can resume to the
    // same state afterward, instead of always landing back on Pause.
    this._speedBeforeHireMode = { paused:this.paused, speedMult:this.speedMult };
    this.paused = true;
    // The sim logic does pause (nothing changes underneath while placing them), but - same as
    // dragging out a new room in Build mode, which never shows the overlay either - there's no
    // dimmed "⏸ PAUSED" screen for this. It's a lightweight hold for placement, not a real pause
    // the player asked for.
    document.getElementById("pauseOverlay").classList.remove("show");
    this._syncCancelBtn();
    this.pushToast(st.name+" hired - tap a room to assign them.", "good");
    this.save();
    return st;
  }
  beginHirePlacement(type, specialty){
    this.closeAllPanels();
    this._finalizeHire(type, specialty, null);
  }
  // Restores whatever speed/pause state was active right before beginHirePlacement, called once
  // the room has been picked (success) or the hire was cancelled - either way, hiring someone
  // shouldn't leave the whole game stuck on Pause afterward.
  _resumeAfterHireMode(){
    if(this._speedBeforeHireMode){
      this.paused = this._speedBeforeHireMode.paused;
      this.speedMult = this._speedBeforeHireMode.speedMult;
      this._syncPlayPauseBtn();
      this._syncPauseOverlay();
      this._speedBeforeHireMode = null;
    }
  }
  // Rolls a fresh batch of candidate profiles for one role (design feedback: the hire browser's
  // list should stay short - a handful of profiles, not an endless scroll). Doctors mix in the
  // two specialist tracks (psychiatrist/surgeon) among the plain generalists, since choosing a
  // specialist IS one of the profiles now rather than a separate toggle.
  _generateHireCandidates(role, count){
    count = count||4;
    const def = STAFF_TYPES[role];
    const quips = HIRE_QUIPS[role] || HIRE_QUIPS.doctor;
    const specialtyPool = role==="doctor" ? [null, null, "psychiatrist", "surgeon"] : [null];
    const list = [];
    for(let i=0;i<count;i++){
      const specialty = specialtyPool[i % specialtyPool.length];
      const workEthic = Math.round(15 + Math.random()*80);
      // Cost scales with work ethic (design feedback: "hourly cost should be tied to
      // productivity - the more workaholic the staff, the more they're paid, both hourly and
      // at hire") - a small amount of independent noise on top so two similarly-driven
      // candidates aren't perfectly interchangeable, but workEthic is clearly the dominant
      // factor rather than a coincidence.
      const costMult = clamp(lerp(0.75, 1.45, workEthic/100) + (Math.random()*0.16-0.08), 0.65, 1.6);
      list.push({
        name: def.name+" "+choice(["Martin","Cole","Rossi","Nkomo","Chen","Garcia","Dubois","Haddad","Okafor","Kowalski"]),
        specialty,
        workEthic,
        costMult,
        quip: quips[Math.floor(Math.random()*quips.length)],
        avatarColor: choice(HIRE_AVATAR_COLORS),
        skillPoints: role==="doctor"
          ? clamp(Math.round(1+Math.random()*999), 1, 1000)
          : clamp(Math.round((def.skill||400)+(Math.random()*200-100)), 1, 1000),
      });
    }
    return list;
  }
  // Opens the face-browser hire window (design feedback): a role column on the left, a
  // scrollable candidate profile on the right - portrait, name, a work-ethic bar, hourly cost,
  // and a short flavor line - with prev/next to page through the (deliberately short) list.
  openHireBrowser(){
    this._hireCandidates = this._hireCandidates || {};
    this._hireBrowserRole = this._hireBrowserRole || "doctor";
    this._hireBrowserIndex = this._hireBrowserIndex || 0;
    ["doctor","nurse","maintenance","receptionist","researcher"].forEach(role=>{
      if(!this._hireCandidates[role]) this._hireCandidates[role] = this._generateHireCandidates(role);
    });
    this.closeAllPanels();
    this._renderHireRoleColumn();
    this._renderHireProfile();
    document.getElementById("panelHireBrowser").classList.add("show");
  }
  _renderHireRoleColumn(){
    document.querySelectorAll(".hireRoleBtn").forEach(b=>{
      b.classList.toggle("active", b.dataset.role===this._hireBrowserRole);
    });
  }
  _renderHireProfile(){
    const role = this._hireBrowserRole;
    const list = this._hireCandidates[role];
    const idx = clamp(this._hireBrowserIndex, 0, list.length-1);
    this._hireBrowserIndex = idx;
    const c = list[idx];
    const def = STAFF_TYPES[role];
    const surcharge = c.specialty && SPECIALTIES[c.specialty] ? SPECIALTIES[c.specialty].salarySurcharge : 0;
    const dailyCost = Math.round(def.salary*c.costMult) + surcharge;
    const hourly = Math.max(1, Math.round(dailyCost/8));
    const hireCost = Math.round(def.cost*c.costMult);
    const specLabel = c.specialty ? " · "+c.specialty[0].toUpperCase()+c.specialty.slice(1) : "";
    document.getElementById("hireProfileCard").innerHTML = `
      <div class="hireAvatar" style="background:${c.avatarColor};">${def.symbol}</div>
      <div class="hireName">${c.name}${specLabel}</div>
      <div class="hireStatRow"><span>Break-loving</span><span>Workaholic</span></div>
      <div class="hireEthicBar"><div class="hireEthicFill" style="left:${c.workEthic}%;"></div></div>
      <div style="height:8px;"></div>
      <div class="hireStatRow"><span>Hourly cost</span><b>$${hourly}/hr</b></div>
      <div class="hireStatRow"><span>Hire cost</span><b>${fmtMoney(hireCost)} $</b></div>
      <div class="hireQuip">"${c.quip}"</div>
      <div class="hireDots">${list.map((_,i)=>`<span class="${i===idx?'active':''}"></span>`).join("")}</div>
    `;
    const affordable = this.economy.canAfford(hireCost);
    const confirmBtn = document.getElementById("hireConfirmBtn");
    if(confirmBtn){ confirmBtn.disabled = !affordable; confirmBtn.style.opacity = affordable? "1":"0.5"; }
  }
  _hireFromBrowser(){
    const role = this._hireBrowserRole;
    const list = this._hireCandidates[role];
    const idx = this._hireBrowserIndex;
    const c = list[idx];
    document.getElementById("panelHireBrowser").classList.remove("show");
    const st = this._finalizeHire(role, c.specialty, {name:c.name, workEthic:c.workEthic, hourlyCostMult:c.costMult, skillPoints:c.skillPoints});
    if(st){
      // that profile is taken - roll a fresh one into the same slot so it's not hireable twice
      list[idx] = this._generateHireCandidates(role, 1)[0];
    }
  }
  cancelHireMode(){
    if(this.hireMode){
      const st = this.staff.find(s=>s.id===this.hireMode.staffId);
      // if they were never actually placed anywhere, cancelling refunds and removes them -
      // otherwise (placement already succeeded and cleared hireMode before this could be called
      // from anywhere else) there's nothing left to undo
      if(st && st.pendingHire && !st.assignedRoomId){
        this.economy.earn(st.def.cost);
        this.staff = this.staff.filter(s=>s.id!==st.id);
      }
    }
    this.hireMode = null;
    this._syncCancelBtn();
    this._resumeAfterHireMode();
  }
  // Legacy direct-hire path (auto-assigns to the first compatible room, no placement step) -
  // kept for save-compatibility and any internal callers that want the old one-shot behavior.
  hireStaff(type, specialty){
    const def = STAFF_TYPES[type];
    if(!this.economy.canAfford(def.cost)){ this.pushToast("Not enough money to hire.", "bad", true); return; }
    // spawn near a staffroom or reception if exists, else map center
    const homeRoom = this.hospital.roomsOfType("staffroom")[0] || this.hospital.roomsOfType("reception")[0];
    const pos = homeRoom? this.hospital.roomCenterWorld(homeRoom) : {x:MAP_W*TILE/2,y:MAP_H*TILE/2};
    this.economy.spend(def.cost);
    const st = new Staff(type, pos.x, pos.y, specialty||null);
    this.staff.push(st);

    // try to auto-assign to the first compatible room with a free slot, so new hires aren't idle by default
    const compatible = this.hospital.rooms.find(r=>{
      const rd = ROOM_TYPES[r.type];
      const cap = r.staffCapacity!=null ? r.staffCapacity : (rd.capacity||1);
      if(r._constructing || r._demolishing) return false;
      if(rd.surgeonsRequired>1 && r.staffIds.length===0) return false; // don't auto-start a fresh Operating Theatre team with a single hire - let the player knowingly staff both slots
      if(rd.needsConsultant && r.staffIds.length===0 && st.rank!=="consultant") return false; // same idea: an empty Training Room needs a Consultant trainer first, not a random Junior with nobody to teach them
      return roleFitsRoom(st, rd) && r.staffIds.length < cap;
    });
    if(compatible){
      this.assignStaffToRoom(st.id, compatible.id);
      this.pushToast(st.name+" hired and assigned to "+ROOM_TYPES[compatible.type].name+"!", "good");
    } else {
      this.pushToast(st.name+" hired! Tap them to assign a room.", "good");
    }
    this.save();
  }

  assignStaffToRoom(staffId, roomId, silent){
    const s = this.staff.find(x=>x.id===staffId);
    const room = this.hospital.rooms.find(r=>r.id===roomId);
    if(!s || !room) return false;
    const def = ROOM_TYPES[room.type];
    if(room._constructing){
      if(!silent) this.pushToast("This room is still under construction.", "bad");
      return false;
    }
    if(room._demolishing){
      if(!silent) this.pushToast("This room is being demolished.", "bad");
      return false;
    }
    // Role-fit is enforced here, at the single canonical assignment entry point, so it applies
    // no matter which UI path triggered it (the hire-then-tap-a-room flow, the staff detail
    // panel's room picker, or any future caller) - a Receptionist can't be sent to work a
    // Consultation Room, a Janitor can't staff Reception, etc.
    if(!roleFitsRoom(s, def)){
      if(!silent) this.pushToast(s.def.name+" can't work in a "+def.name+".", "bad");
      return false;
    }
    const capacity = room.staffCapacity!=null ? room.staffCapacity : (def.capacity||1);
    if(room.staffIds.length >= capacity && room.id!==s.assignedRoomId){
      if(!silent) this.pushToast("This room is full.", "bad");
      return false;
    }
    // remove from any previous room
    this.hospital.rooms.forEach(r=>{ r.staffIds = r.staffIds.filter(id=>id!==s.id); });
    room.staffIds.push(s.id);
    s.assignedRoomId = room.id;
    s.slotIndex = this.hospital.freeStaffSlotIndex(room, this.staff, s.id);
    s.state = "idle";
    s.atSlot = false;
    s.path = null;
    if(s.pendingHire){
      // freshly hired and just placed: a short onboarding delay before they actually start
      // walking to work (see the "idle" case), instead of showing up instantly.
      s.pendingHireTimer = CONSTRUCTION_SECONDS;
    }
    if(!silent) this.pushToast(s.name+" assigned to "+def.name+".", "good");
    this.save();
    return true;
  }

  _refreshBuildList(){
    const roomList = document.getElementById("roomList");
    roomList.innerHTML = "";
    const buildable = ROOM_ORDER.concat(
      LOCKED_ROOM_ORDER.filter(key => this.unlockedResearch.has(ROOM_TYPES[key].unlockedBy))
    );
    // Group into the Theme-Hospital-style categories (Diagnostic / Treatment / Specialist
    // Clinics / Facilities) from GAME_DATA.config.roomCategories so the build panel reads as
    // a coherent catalogue rather than one long flat list, now that there are ~27 room types.
    const byCategory = {};
    Object.keys(ROOM_CATEGORIES).forEach(cat => byCategory[cat] = []);
    buildable.forEach(key=>{
      const cat = ROOM_TYPES[key].category || "facility";
      (byCategory[cat] || (byCategory[cat]=[])).push(key);
    });
    Object.keys(ROOM_CATEGORIES).forEach(cat=>{
      const keys = byCategory[cat];
      if(!keys || !keys.length) return;
      const header = document.createElement("div");
      header.className = "entityListLabel";
      header.textContent = ROOM_CATEGORIES[cat];
      roomList.appendChild(header);
      keys.forEach(key=>{
        const def = ROOM_TYPES[key];
        const role = this._roleForRoom(def);
        const sizeStr = `${def.minW}×${def.minH} min`;
        const roleStr = role ? ` · needs ${role.label}${def.surgeonsRequired>1?` ×${def.surgeonsRequired}`:""}` : "";
        const el = document.createElement("div");
        el.className="roomOption";
        el.innerHTML = `<div class="roomSwatch" style="background:${def.color}"></div>
          <div class="meta"><b>${def.name}</b><span>${def.desc}</span><span>${sizeStr}${roleStr}</span></div>
          <div class="cost">${fmtMoney(def.cost)} $</div>`;
        el.addEventListener("click", ()=>{
          document.querySelectorAll(".roomOption").forEach(o=>o.classList.remove("selected"));
          el.classList.add("selected");
          this.buildMode = {type:key};
          this.closeAllPanels();
          this.pushToast("Drag on the map to place: "+def.name, null);
          this._syncCancelBtn();
        });
        roomList.appendChild(el);
      });
    });
  }

  _syncCancelBtn(){
    document.getElementById("cancelModeBtn").classList.toggle("show", !!this.buildMode || !!this.placeMode);
  }

  _refreshFurnitureList(){
    const list = document.getElementById("furnitureList");
    list.innerHTML = "";
    Object.keys(OBJECT_TYPES).forEach(key=>{
      const def = OBJECT_TYPES[key];
      const el = document.createElement("div");
      el.className="roomOption furnitureOption";
      el.innerHTML = `<div class="roomSwatch" style="background:#eee2cc;display:flex;align-items:center;justify-content:center;font-size:18px;">${def.symbol}</div>
        <div class="meta"><b>${def.name}</b><span>${def.desc}</span></div>
        <div class="cost">${fmtMoney(def.cost)} $</div>`;
      el.addEventListener("click", ()=>{
        document.querySelectorAll(".furnitureOption").forEach(o=>o.classList.remove("selected"));
        el.classList.add("selected");
        this.placeMode = {type:key};
        this.closeAllPanels();
        document.getElementById("fpTitle").textContent = def.symbol+" "+def.name;
        document.getElementById("fpDetail").textContent = "Tap an open floor tile ("+fmtMoney(def.cost)+" $)";
        document.getElementById("furniturePlaceBar").classList.add("show");
        this._syncCancelBtn();
      });
      list.appendChild(el);
    });
  }

  _refreshResearchPanel(){
    const list = document.getElementById("researchList");
    list.innerHTML = "";
    const ptsRow = document.createElement("div");
    ptsRow.className="statRow";
    ptsRow.innerHTML = `<span class="label">🔬 Points</span><b>${Math.floor(this.economy.researchPoints)}</b>`;
    list.appendChild(ptsRow);

    const hint = document.createElement("div");
    hint.style.cssText="font-size:11.5px;color:#666;margin:4px 0 10px;";
    hint.textContent = "Assign researchers to a research lab to generate points.";
    list.appendChild(hint);

    RESEARCH_PROJECTS.forEach(proj=>{
      const done = this.unlockedResearch.has(proj.id);
      const lockedByPrereq = proj.requires && !this.unlockedResearch.has(proj.requires);
      const pct = clamp(this.economy.researchPoints/proj.cost*100, 0, 100);
      const row = document.createElement("div");
      row.style.cssText="margin-bottom:12px;padding:10px;border-radius:12px;background:rgba(0,0,0,.03);";
      row.innerHTML = `
        <div class="statRow"><span class="label" style="width:auto;flex:1;"><b>${proj.name}</b></span>
          <b>${done? "✅ Unlocked" : (proj.cost+" pts")}</b></div>
        <div style="font-size:11.5px;color:#666;margin:2px 0 6px;">${proj.desc}</div>
        ${done? "" : `<div class="barTrack"><div class="barFill" style="width:${pct}%;background:var(--teal)"></div></div>`}
        ${lockedByPrereq && !done? `<div style="font-size:11px;color:#a55;margin-top:6px;">🔒 Requires: ${RESEARCH_PROJECTS.find(p=>p.id===proj.requires).name}</div>` : ""}
      `;
      if(!done && !lockedByPrereq){
        const btn = document.createElement("button");
        btn.className="panelBtn primary";
        btn.style.marginTop="8px";
        btn.textContent = "Unlock";
        btn.disabled = this.economy.researchPoints < proj.cost;
        btn.style.opacity = btn.disabled? "0.5":"1";
        btn.addEventListener("click", ()=>{ this.unlockResearch(proj.id); });
        row.appendChild(btn);
      }
      list.appendChild(row);
    });
  }

  _refreshManagePanel(){
    document.getElementById("mgIncome").textContent = fmtMoney(this.economy.dailyIncome)+" $";
    document.getElementById("mgExpense").textContent = fmtMoney(this.economy.dailyExpense)+" $";
    document.getElementById("mgStaffCount").textContent = this.staff.length;
    document.getElementById("mgRoomCount").textContent = this.hospital.rooms.length;
    this._renderEconomyChart();
  }

  // Interest rate quote for a loan (design feedback: "un taux d'intérêt qui dépend du montant
  // emprunté, de la durée, etc") - a base rate that climbs with both how much is borrowed and
  // how long it's borrowed for, since both make the loan riskier for the bank. Returns an
  // annual rate; daily compounding is derived from this in _computeLoanQuote.
  _quoteLoanRate(amount, termDays){
    const amountFactor = clamp(amount/50000, 0, 1) * 0.06;
    const termFactor = clamp(termDays/90, 0, 1) * 0.05;
    return 0.10 + amountFactor + termFactor; // 10%-21% APR
  }
  // Standard amortization math: a fixed daily payment that pays off both principal and accrued
  // interest over exactly termDays days.
  _computeLoanQuote(amount, termDays){
    const annualRate = this._quoteLoanRate(amount, termDays);
    const dailyRate = annualRate/365;
    const dailyPayment = dailyRate<=0 ? amount/termDays : amount*dailyRate/(1-Math.pow(1+dailyRate,-termDays));
    const totalRepaid = dailyPayment*termDays;
    return { annualRate, dailyRate, dailyPayment, totalRepaid, totalInterest: totalRepaid-amount };
  }
  takeLoan(amount, termDays){
    if(this.loan){ this.pushToast("You already have an active loan - pay it off first.", "bad", true); return; }
    amount = clamp(Math.round(amount/500)*500, 500, 50000);
    termDays = clamp(Math.round(termDays), 7, 90);
    const quote = this._computeLoanQuote(amount, termDays);
    this.economy.earn(amount);
    this.loan = {
      principal: amount, annualRate: quote.annualRate, dailyRate: quote.dailyRate,
      dailyPayment: quote.dailyPayment, termDays, daysRemaining: termDays,
      balance: amount, totalPaid: 0, interestPaid: 0,
    };
    this.pushToast("Loan of "+fmtMoney(amount)+" $ taken - "+fmtMoney(Math.round(quote.dailyPayment))+" $/day for "+termDays+" days.", "good");
    this._refreshLoanPanel();
    this.save();
  }
  // Called once per in-game day (see _onNewDay) - takes the fixed daily payment out of the
  // takings automatically, same idea as staff salaries or room upkeep, and tracks running
  // totals so the loan panel can show exactly how much has been paid and how much was interest.
  _chargeLoanPayment(){
    if(!this.loan) return;
    const interestPortion = this.loan.balance*this.loan.dailyRate;
    let payment = this.loan.dailyPayment;
    if(this.loan.daysRemaining<=1) payment = this.loan.balance+interestPortion; // clears exactly, no stray fractional balance
    payment = Math.round(payment);
    this.economy.spend(payment);
    this.loan.balance = Math.max(0, this.loan.balance+interestPortion-payment);
    this.loan.totalPaid += payment;
    this.loan.interestPaid += interestPortion;
    this.loan.daysRemaining--;
    if(this.loan.daysRemaining<=0 || this.loan.balance<=0.5){
      this.pushToast("🏦 Loan fully repaid!", "good", true);
      this.loan = null;
    }
  }
  payOffLoan(){
    if(!this.loan) return;
    const remaining = Math.round(this.loan.balance);
    if(!this.economy.canAfford(remaining)){ this.pushToast("Not enough money to pay off the loan.", "bad", true); return; }
    this.economy.spend(remaining);
    this.loan = null;
    this.pushToast("🏦 Loan paid off early!", "good");
    this._refreshLoanPanel();
    this.save();
  }
  _refreshLoanPanel(){
    const noneView = document.getElementById("loanNoneView");
    const activeView = document.getElementById("loanActiveView");
    if(this.loan){
      noneView.style.display = "none";
      activeView.style.display = "";
      document.getElementById("loanActivePrincipal").textContent = fmtMoney(this.loan.principal)+" $";
      document.getElementById("loanActiveRate").textContent = Math.round(this.loan.annualRate*100)+"% APR";
      document.getElementById("loanActiveDaily").textContent = fmtMoney(Math.round(this.loan.dailyPayment))+" $/day";
      document.getElementById("loanActiveDaysLeft").textContent = this.loan.daysRemaining+" days";
      document.getElementById("loanActiveBalance").textContent = fmtMoney(Math.round(this.loan.balance))+" $";
      document.getElementById("loanActivePaid").textContent = fmtMoney(Math.round(this.loan.totalPaid))+" $";
      document.getElementById("loanActiveInterestPaid").textContent = fmtMoney(Math.round(this.loan.interestPaid))+" $";
    } else {
      noneView.style.display = "";
      activeView.style.display = "none";
      this._refreshLoanQuote();
    }
  }
  _refreshLoanQuote(){
    const amount = parseInt(document.getElementById("loanAmountSlider").value,10);
    const termDays = parseInt(document.getElementById("loanTermSlider").value,10);
    document.getElementById("loanAmountVal").textContent = fmtMoney(amount);
    document.getElementById("loanTermVal").textContent = termDays;
    const quote = this._computeLoanQuote(amount, termDays);
    document.getElementById("loanQuoteRate").textContent = Math.round(quote.annualRate*100)+"% APR";
    document.getElementById("loanQuoteDaily").textContent = fmtMoney(Math.round(quote.dailyPayment))+" $/day";
    document.getElementById("loanQuoteTotal").textContent = fmtMoney(Math.round(quote.totalRepaid))+" $";
    document.getElementById("loanQuoteInterest").textContent = fmtMoney(Math.round(quote.totalInterest))+" $";
  }

  // Full staff roster (design feedback: needs a global list, not just "who's in this room"),
  // grouped by role so it reads as a directory rather than a flat dump. Every row opens the
  // same detail panel as tapping the person on the map.
  _refreshStaffRoster(){
    document.getElementById("staffRosterCount").textContent = this.staff.length;
    const list = document.getElementById("staffRosterList");
    if(!list) return;
    list.innerHTML = "";
    if(this.staff.length===0){
      list.innerHTML = '<div style="font-size:11.5px;color:#999;padding:14px 4px;text-align:center;">No staff hired yet.</div>';
      return;
    }
    const sortKey = this._staffSortKey || "role";
    const rowFor = (s)=>{
      const room = this.hospital.rooms.find(r=>r.id===s.assignedRoomId);
      const row = document.createElement("div");
      row.className="entityRow";
      row.innerHTML = `<span class="ic">${s.def.symbol}</span><span class="nm">${s.name}${s.specialty?" · "+s.specialty[0].toUpperCase()+s.specialty.slice(1):""}</span><span class="st">${room? ROOM_TYPES[room.type].name : this._staffStateLabel(s.state)}</span>`;
      row.addEventListener("click", ()=>{ this.closeAllPanels(); this._openSelection({kind:"staff", entity:s}); });
      return row;
    };
    if(sortKey==="role"){
      // grouped by role, as before - this is the one case where a group header makes sense
      const groups = {};
      this.staff.forEach(s=>{ (groups[s.type] = groups[s.type]||[]).push(s); });
      Object.keys(STAFF_TYPES).forEach(type=>{
        const members = groups[type];
        if(!members || !members.length) return;
        const label = document.createElement("div");
        label.className="entityListLabel"; label.textContent = STAFF_TYPES[type].name+" ("+members.length+")";
        list.appendChild(label);
        members.forEach(s=> list.appendChild(rowFor(s)));
      });
    } else {
      // flat, sorted list for every other sort mode
      const sorted = [...this.staff];
      if(sortKey==="name") sorted.sort((a,b)=>a.name.localeCompare(b.name));
      else if(sortKey==="energy") sorted.sort((a,b)=>a.energy-b.energy); // most tired first - who needs a rest
      else if(sortKey==="thirst") sorted.sort((a,b)=>(b.thirst||0)-(a.thirst||0)); // thirstiest first
      else if(sortKey==="skill") sorted.sort((a,b)=>b.skillPoints-a.skillPoints); // most skilled first
      sorted.forEach(s=> list.appendChild(rowFor(s)));
    }
  }

  // Full patient roster, sortable so a specific problem patient (the one an alert mentioned,
  // e.g. "X patients are unhappy and may leave") is actually easy to find instead of scanning
  // a long unordered list.
  _refreshPatientsRoster(){
    const list = document.getElementById("patientsRosterList");
    if(!list) return;
    list.innerHTML = "";
    const visible = this.patients.filter(p=>p.state!=="gone");
    if(visible.length===0){
      list.innerHTML = '<div style="font-size:11.5px;color:#999;padding:14px 4px;text-align:center;">No patients in the hospital right now.</div>';
      return;
    }
    const stageLabel = (p)=>{
      if(p.state==="beingConsulted") return "with the GP";
      if(p.state==="beingTreated") return "in treatment";
      if(p.state==="dead") return "deceased";
      if(p.state==="leaving"||p.state==="walkOut") return "leaving";
      if(p.state && p.state.startsWith("queue")) return "waiting";
      return "walking in";
    };
    const sortKey = this._patientSortKey || "mood";
    const sorted = [...visible];
    if(sortKey==="mood") sorted.sort((a,b)=> (a.happiness??100) - (b.happiness??100));
    else if(sortKey==="health") sorted.sort((a,b)=> (a.health??100) - (b.health??100));
    else if(sortKey==="thirst") sorted.sort((a,b)=> (b.thirst||0) - (a.thirst||0));
    else if(sortKey==="name") sorted.sort((a,b)=> a.name.localeCompare(b.name));
    else if(sortKey==="disease") sorted.sort((a,b)=> a.disease.name.localeCompare(b.disease.name));
    else if(sortKey==="stage") sorted.sort((a,b)=> stageLabel(a).localeCompare(stageLabel(b)));
    sorted.forEach(p=>{
      const row = document.createElement("div");
      // Emergency patients get a distinct highlighted row (design feedback: hard to spot which
      // patient an "X patients are unhappy" alert is even talking about) - pairs with the
      // pulsing marker drawn over them on the map itself, see _drawPatient.
      row.className="entityRow"+(p.isEmergency?" emergencyRow":"");
      const emergencyTag = p.isEmergency ? " 🚨" : "";
      row.innerHTML = `<span class="ic">${p.disease.symptom}</span><span class="nm">${p.name}${emergencyTag}</span><span class="st">${stageLabel(p)}</span>`;
      row.addEventListener("click", ()=>{ this.closeAllPanels(); this._openSelection({kind:"patient", entity:p}); });
      list.appendChild(row);
    });
  }

  // Only the currently-visible Directory tab's pane gets refreshed - avoids doing all three
  // roster rebuilds every ~0.2s live-refresh tick when only one is actually on screen.
  _refreshDirectoryActivePane(){
    const tab = this._directoryActiveTab || "dirTabStaff";
    if(tab==="dirTabStaff") this._refreshStaffRoster();
    else if(tab==="dirTabPatients") this._refreshPatientsRoster();
    else if(tab==="dirTabRooms") this._refreshRoomsRoster();
  }

  // Rooms tab of the Directory (design feedback: "a list of built rooms with simple stats -
  // health/condition, occupancy, waiting list, last seen - something simple but very visual").
  // Each row is a compact card: name + queue badge, a colored condition bar, and a one-line
  // summary of staffing and how long it's been since a patient was actually served there.
  _refreshRoomsRoster(){
    const list = document.getElementById("roomsRosterList");
    if(!list) return;
    list.innerHTML = "";
    const rooms = this.hospital.rooms;
    if(rooms.length===0){
      list.innerHTML = '<div style="font-size:11.5px;color:#999;padding:14px 4px;text-align:center;">No rooms built yet.</div>';
      return;
    }
    const hoursPerSimSecond = 24/this.dayLength;
    const lastSeenHours = (r)=> r.lastServedAt==null ? Infinity : (this.simTime-r.lastServedAt)*hoursPerSimSecond;
    const sortKey = this._roomSortKey || "queue";
    const sorted = [...rooms];
    if(sortKey==="queue") sorted.sort((a,b)=> (b.queue?.length||0) - (a.queue?.length||0));
    else if(sortKey==="condition") sorted.sort((a,b)=> (a.condition??100) - (b.condition??100));
    else if(sortKey==="name") sorted.sort((a,b)=> ROOM_TYPES[a.type].name.localeCompare(ROOM_TYPES[b.type].name));
    else if(sortKey==="lastSeen") sorted.sort((a,b)=> lastSeenHours(b) - lastSeenHours(a));
    sorted.forEach(r=>{
      const def = ROOM_TYPES[r.type];
      const card = document.createElement("div");
      card.className = "roomRosterCard";
      if(r._constructing || r._demolishing){
        card.innerHTML = `
          <div class="roomRosterHead"><b>${def.name}</b><span class="roomRosterBadge">${r._constructing? "🚧 building":"🧱 demolishing"}</span></div>
        `;
      } else {
        const cond = Math.round(r.condition==null?100:r.condition);
        const condColor = cond<40? "var(--danger)" : cond<70? "var(--gold)" : "var(--leaf)";
        const cap = r.staffCapacity!=null ? r.staffCapacity : (def.capacity||0);
        const staffed = r.staffIds.length;
        const queueLen = r.queue? r.queue.length : 0;
        const queueColor = queueLen>=5? "var(--danger)" : queueLen>=2? "var(--gold)" : "#888";
        const lastSeenText = r.lastServedAt==null
          ? (r.patientsServed>0 ? "-" : "Never")
          : Math.round(lastSeenHours(r))+"h ago";
        const staffedText = def.category==="facility" && r.type!=="reception" && r.type!=="waitingRoom"
          ? "" // toilets/staffroom/etc don't have a dedicated worker in the same sense
          : (cap>0 ? `${staffed}/${cap} staffed` : "");
        card.innerHTML = `
          <div class="roomRosterHead"><b>${def.name}</b><span class="roomRosterBadge" style="color:${queueColor};">${queueLen>0?"⏳ "+queueLen+" waiting":"no queue"}</span></div>
          <div class="barTrack"><div class="barFill" style="width:${cond}%;background:${condColor}"></div></div>
          <div class="roomRosterMeta">${staffedText}${staffedText?" · ":""}Last patient: ${lastSeenText}${r.machineBroken?" · ⚠ machine broken":""}</div>
        `;
      }
      card.addEventListener("click", ()=>{ this.closeAllPanels(); this._openRoomInfo(r); });
      list.appendChild(card);
    });
  }

  // One-time pointer/wheel setup for the Hospital Guide's pan/zoom viewport - independent of
  // the main game camera, so browsing the guide never nudges the actual map view.
  _setupRoomTreePanZoom(){
    this._treeView = { x:0, y:0, zoom:0.85 };
    const viewport = document.getElementById("roomTreeViewport");
    if(!viewport) return;
    const pointers = new Map();
    let lastPanX=0, lastPanY=0, pinchStartDist=0, pinchStartZoom=1, mode=null;
    const onDown = (id,x,y)=>{
      pointers.set(id,{x,y});
      if(pointers.size===1){ mode="pan"; lastPanX=x; lastPanY=y; }
      else if(pointers.size===2){
        mode="pinch";
        const pts=[...pointers.values()];
        pinchStartDist = Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y);
        pinchStartZoom = this._treeView.zoom;
      }
    };
    const onMoveP = (id,x,y)=>{
      if(!pointers.has(id)) return;
      pointers.set(id,{x,y});
      if(mode==="pan" && pointers.size===1){
        this._treeView.x += x-lastPanX;
        this._treeView.y += y-lastPanY;
        lastPanX=x; lastPanY=y;
        this._applyTreeTransform();
      } else if(mode==="pinch" && pointers.size>=2){
        const pts=[...pointers.values()];
        const d = Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y);
        if(pinchStartDist>0){
          this._treeView.zoom = clamp(pinchStartZoom*(d/pinchStartDist), 0.35, 2.2);
          this._applyTreeTransform();
        }
      }
    };
    const onUp = (id)=>{ pointers.delete(id); if(pointers.size===0) mode=null; };
    viewport.addEventListener("pointerdown", e=>{ viewport.setPointerCapture(e.pointerId); onDown(e.pointerId, e.clientX, e.clientY); });
    viewport.addEventListener("pointermove", e=>onMoveP(e.pointerId, e.clientX, e.clientY));
    viewport.addEventListener("pointerup", e=>onUp(e.pointerId));
    viewport.addEventListener("pointercancel", e=>onUp(e.pointerId));
    viewport.addEventListener("wheel", e=>{
      e.preventDefault();
      this._treeView.zoom = clamp(this._treeView.zoom * (e.deltaY<0?1.1:0.9), 0.35, 2.2);
      this._applyTreeTransform();
    }, {passive:false});
  }
  _applyTreeTransform(){
    const inner = document.getElementById("roomTreeInner");
    if(!inner) return;
    const v = this._treeView;
    inner.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.zoom})`;
  }
  // Centers the view on Reception/Consultation (the natural starting point of the flow) every
  // time the guide is opened, and redraws it against the hospital's current state.
  _openRoomTree(){
    const viewport = document.getElementById("roomTreeViewport");
    this._treeView = { x: (viewport?viewport.clientWidth/2:150) - 260*0.85, y: (viewport?viewport.clientHeight/2:150) - 260*0.85, zoom:0.85 };
    this._applyTreeTransform();
    this._renderRoomTree();
  }
  // Redraws every node + connecting line in the Hospital Guide. Rooms are grouped by TYPE (one
  // node per type, however many physical instances exist) and colored by how congested that
  // type is right now - the whole point being a quick "what should I build next?" glance:
  // gray = not built yet, green = quiet, orange = getting busy, red = overloaded.
  _renderRoomTree(){
    const inner = document.getElementById("roomTreeInner");
    const svg = document.getElementById("roomTreeSvg");
    if(!inner || !svg) return;
    inner.querySelectorAll(".roomTreeNode").forEach(n=>n.remove());

    const diagnosticOthers = Object.keys(ROOM_TYPES).filter(k=>ROOM_TYPES[k].category==="diagnostic" && k!=="consultation" && ROOM_TREE_LAYOUT[k]);
    const treatmentLike = Object.keys(ROOM_TYPES).filter(k=>(ROOM_TYPES[k].category==="treatment"||ROOM_TYPES[k].category==="clinic") && ROOM_TREE_LAYOUT[k]);
    // Two different kinds of edge, styled differently (design feedback: everything after
    // Consultation looked like one flat, undifferentiated level, but the real flow isn't
    // symmetric): diagnostic rooms are a side-loop patients bounce back to Consultation from
    // (dashed curve, no strong arrowhead - "you might come back here"), while treatment/clinic
    // rooms are the one-way final destination once actually diagnosed (solid straight line,
    // arrowhead pointing at the room, "this is where the visit - and the money - ends").
    // Diagnostic rooms are sorted strongest-first (design feedback: which one's actually
    // better wasn't clear) so both their vertical position and their loop's curve order read
    // as a rough "most to least effective" ranking, top to bottom.
    diagnosticOthers.sort((a,b)=>(ROOM_TYPES[b].diagnosisPower||0)-(ROOM_TYPES[a].diagnosisPower||0));
    const loopEdges = diagnosticOthers.map(k=>["consultation",k]);
    const finalEdges = [["reception","consultation"], ...treatmentLike.map(k=>["consultation",k])];

    // Average payout for each treatment/clinic room, from every disease that's actually cured
    // there (design feedback: which rooms are the "final", money-making ones wasn't obvious).
    const avgRewardByRoom = {};
    Object.values(DISEASES).forEach(d=>{
      if(!avgRewardByRoom[d.room]) avgRewardByRoom[d.room] = {sum:0,count:0};
      avgRewardByRoom[d.room].sum += d.reward;
      avgRewardByRoom[d.room].count++;
    });

    const NW=120, NH=44; // node box size, must match .roomTreeNode's CSS width + approx height
    let maxX=0, maxY=0;
    Object.values(ROOM_TREE_LAYOUT).forEach(p=>{ maxX=Math.max(maxX,p.x+NW); maxY=Math.max(maxY,p.y+NH); });
    svg.setAttribute("width", maxX+40);
    svg.setAttribute("height", maxY+40);
    svg.innerHTML = "";

    const defs = document.createElementNS("http://www.w3.org/2000/svg","defs");
    const marker = document.createElementNS("http://www.w3.org/2000/svg","marker");
    marker.setAttribute("id","treeArrow"); marker.setAttribute("viewBox","0 0 10 10");
    marker.setAttribute("refX","8"); marker.setAttribute("refY","5");
    marker.setAttribute("markerWidth","7"); marker.setAttribute("markerHeight","7");
    marker.setAttribute("orient","auto-start-reverse");
    const arrowPath = document.createElementNS("http://www.w3.org/2000/svg","path");
    arrowPath.setAttribute("d","M0,0 L10,5 L0,10 z"); arrowPath.setAttribute("fill","#c98a4a");
    marker.appendChild(arrowPath);
    defs.appendChild(marker);
    svg.appendChild(defs);

    // Straight final-treatment edges: stop just short of the target box so the arrowhead lands
    // outside it rather than hiding behind it. Anchored to a source-side point that fans out
    // vertically with the target's own position (design feedback: every line used to leave from
    // the exact same center point and pile up into an unreadable knot) instead of one dead center.
    const drawFinalEdge = (a,b,opts,index,total)=>{
      const pa = ROOM_TREE_LAYOUT[a], pb = ROOM_TREE_LAYOUT[b];
      if(!pa || !pb) return;
      const fanSpread = Math.min(NH*0.7, 16);
      const startY = pa.y+NH/2 + (total>1 ? (index/(total-1)-0.5)*fanSpread : 0);
      const cax=pa.x+NW, cay=startY, cbx=pb.x, cby=pb.y+NH/2;
      const dx=cbx-cax, dy=cby-cay, dist=Math.hypot(dx,dy)||1;
      const pullBack = 10;
      const ex = cbx-(dx/dist)*pullBack, ey = cby-(dy/dist)*pullBack;
      const line = document.createElementNS("http://www.w3.org/2000/svg","line");
      line.setAttribute("x1", cax); line.setAttribute("y1", cay);
      line.setAttribute("x2", ex); line.setAttribute("y2", ey);
      line.setAttribute("stroke", opts.color); line.setAttribute("stroke-width", opts.width);
      line.setAttribute("marker-end", "url(#treeArrow)");
      svg.appendChild(line);
    };
    // Curved loop edges (diagnostic <-> Consultation): a gentle arc, bowing upward more for the
    // stronger/higher-ranked diagnostic rooms and less for weaker ones, so the bundle fans out
    // into distinct arcs instead of a pile of overlapping straight lines all along the same path.
    const drawLoopEdge = (a,b,index,total)=>{
      const pa = ROOM_TREE_LAYOUT[a], pb = ROOM_TREE_LAYOUT[b];
      if(!pa || !pb) return;
      const startY = pa.y+NH*0.3;
      const x1=pa.x+NW, y1=startY, x2=pb.x, y2=pb.y+NH/2;
      const bow = 30 + index*22; // each successive loop arcs further out, separating them
      const midX = (x1+x2)/2, midY = (y1+y2)/2 - bow;
      const path = document.createElementNS("http://www.w3.org/2000/svg","path");
      path.setAttribute("d", `M${x1},${y1} Q${midX},${midY} ${x2},${y2}`);
      path.setAttribute("fill","none");
      path.setAttribute("stroke","#b9c2a8"); path.setAttribute("stroke-width","1.5");
      path.setAttribute("stroke-dasharray","5,4");
      svg.appendChild(path);
    };
    loopEdges.forEach(([a,b],i)=> drawLoopEdge(a,b,i,loopEdges.length));
    finalEdges.forEach(([a,b],i)=> drawFinalEdge(a,b,{color:"#c98a4a", width:2.5},i,finalEdges.length));

    Object.keys(ROOM_TREE_LAYOUT).forEach(type=>{
      const def = ROOM_TYPES[type];
      if(!def) return;
      const pos = ROOM_TREE_LAYOUT[type];
      const instances = this.hospital.roomsOfType(type);
      const node = document.createElement("div");
      node.className = "roomTreeNode"+(instances.length===0?" dimmed":"");
      node.style.left = pos.x+"px"; node.style.top = pos.y+"px"; node.style.width=NW+"px";
      let borderColor = "#ccc", subText = "Not built";
      if(instances.length>0){
        const totalQueue = instances.reduce((s,r)=>s+(r.queue?r.queue.length:0),0);
        const avgQueue = totalQueue/instances.length;
        borderColor = avgQueue>=4 ? "#c0473a" : avgQueue>=1.5 ? "#e8b13c" : "#8fbf7a";
        subText = instances.length+" built"+(totalQueue>0?" · "+totalQueue+" waiting":"");
      }
      // Extra badge: diagnostic power for diagnostic-tier rooms (so their relative usefulness
      // is visible at a glance), or average payout for the "final" treatment/clinic rooms that
      // actually earn money when a patient is cured there.
      let badge = "";
      if(def.category==="diagnostic" && type!=="consultation" && def.diagnosisPower){
        badge = `<span class="badge">🔬 +${def.diagnosisPower} power</span>`;
      } else if(avgRewardByRoom[type]){
        const avg = Math.round(avgRewardByRoom[type].sum/avgRewardByRoom[type].count);
        badge = `<span class="badge money">💰 ~$${avg}</span>`;
      }
      node.style.borderColor = borderColor;
      node.innerHTML = `<span class="ttl">${def.name}</span><span class="sub">${subText}</span>${badge}<span class="hint">${ROOM_TREE_LAYOUT[type].hint||""}</span>`;
      inner.appendChild(node);
    });
  }

  _renderEconomyChart(){
    const el = document.getElementById("econChart");
    if(!el) return;
    // include today-so-far alongside the recorded history, so the chart isn't empty on day 1
    const hist = this.economy.history.slice(-13).concat([
      { day:this.day, income:this.economy.dailyIncome, expense:this.economy.dailyExpense, live:true }
    ]);
    if(hist.length<=1 && hist[0].income===0 && hist[0].expense===0){
      el.innerHTML = '<div style="font-size:11.5px;color:#999;padding:14px 4px;text-align:center;">Not enough history yet - check back after a day or two.</div>';
      return;
    }
    const w = 280, h = 120, padL=26, padB=16, padT=6;
    const maxVal = Math.max(1, ...hist.map(d=>Math.max(d.income,d.expense)));
    const plotW = w-padL-6, plotH = h-padT-padB;
    const slot = plotW/hist.length;
    const barW = Math.max(3, slot*0.38);
    let bars = "";
    hist.forEach((d,i)=>{
      const x = padL + i*slot + slot*0.08;
      const incH = (d.income/maxVal)*plotH, expH = (d.expense/maxVal)*plotH;
      const op = d.live? 0.55 : 1;
      bars += `<rect x="${x}" y="${padT+plotH-incH}" width="${barW}" height="${Math.max(0,incH)}" fill="#5f9e5a" opacity="${op}"/>`;
      bars += `<rect x="${x+barW+1}" y="${padT+plotH-expH}" width="${barW}" height="${Math.max(0,expH)}" fill="#c0473a" opacity="${op}"/>`;
      if(hist.length<=13 || i%2===0){
        bars += `<text x="${x+barW}" y="${h-3}" font-size="6.5" text-anchor="middle" fill="#999">${d.live?"now":"D"+d.day}</text>`;
      }
    });
    const gridLines = [0,0.5,1].map(f=>{
      const y = padT+plotH*(1-f);
      return `<line x1="${padL}" y1="${y}" x2="${w-6}" y2="${y}" stroke="#e6ded0" stroke-width="1"/>
              <text x="2" y="${y+3}" font-size="6.5" fill="#aaa">${fmtMoney(maxVal*f)}</text>`;
    }).join("");
    el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:120px;display:block;">
        ${gridLines}
        ${bars}
      </svg>
      <div style="display:flex;gap:14px;justify-content:center;font-size:10.5px;margin-top:2px;">
        <span style="color:#5f9e5a;font-weight:700;">■ Income</span>
        <span style="color:#c0473a;font-weight:700;">■ Expenses</span>
      </div>`;
  }

  // Generic line-chart trend viewer, opened by tapping the health/patients/reputation chips.
  _openStatsChart(metric){
    this._openChartMetric = metric;
    const meta = {
      health:     { title:"🏥 Average Patient Health", color:"#5f9e5a", suffix:"%", max:100 },
      patients:   { title:"👥 Patients In Hospital",   color:"#4f8fb0", suffix:"",  max:null },
      reputation: { title:"⭐ Hospital Reputation",     color:"#e8b13c", suffix:"%", max:100 },
      money:      { title:"💰 Money Over Time",         color:"#5f9e5a", suffix:" $", max:null },
    }[metric];
    if(!meta) return;
    document.getElementById("statsChartTitle").textContent = meta.title;
    const el = document.getElementById("statsChart");
    const hist = this.statsHistory;
    if(hist.length<2){
      el.innerHTML = '<div style="font-size:11.5px;color:#999;padding:14px 4px;text-align:center;">Not enough history yet - keep playing a bit and check back.</div>';
      return;
    }
    const w=280, h=130, padL=30, padB=14, padT=8;
    const plotW=w-padL-6, plotH=h-padT-padB;
    const vals = hist.map(d=>d[metric]);
    const maxVal = meta.max || Math.max(1, ...vals);
    const minVal = 0;
    const pts = vals.map((v,i)=>{
      const x = padL + (i/(hist.length-1))*plotW;
      const y = padT + plotH*(1-clamp((v-minVal)/(maxVal-minVal||1),0,1));
      return [x,y];
    });
    const pathD = pts.map((p,i)=>(i===0?"M":"L")+p[0].toFixed(1)+","+p[1].toFixed(1)).join(" ");
    const areaD = pathD+` L${pts[pts.length-1][0].toFixed(1)},${padT+plotH} L${pts[0][0].toFixed(1)},${padT+plotH} Z`;
    const gridLines = [0,0.5,1].map(f=>{
      const y = padT+plotH*(1-f);
      return `<line x1="${padL}" y1="${y}" x2="${w-6}" y2="${y}" stroke="#e6ded0" stroke-width="1"/>
              <text x="2" y="${y+3}" font-size="6.5" fill="#aaa">${Math.round(maxVal*f)}${meta.suffix}</text>`;
    }).join("");
    const current = vals[vals.length-1];
    el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:130px;display:block;">
        ${gridLines}
        <path d="${areaD}" fill="${meta.color}" opacity="0.15"/>
        <path d="${pathD}" fill="none" stroke="${meta.color}" stroke-width="2"/>
        <circle cx="${pts[pts.length-1][0]}" cy="${pts[pts.length-1][1]}" r="3" fill="${meta.color}"/>
      </svg>
      <div style="text-align:center;font-size:12px;font-weight:700;color:${meta.color};margin-top:2px;">Currently: ${current}${meta.suffix}</div>`;
  }

  _refreshObjectives(){
    const list = document.getElementById("objList");
    list.innerHTML="";
    this.objectives.forEach(o=>{
      const val = o.get();
      const pct = clamp(val/o.target*100,0,100);
      o.done = val>=o.target;
      const row = document.createElement("div");
      row.style.marginBottom="10px";
      row.innerHTML = `<div class="statRow"><span class="label">${o.icon} ${o.label}</span><b>${o.done?"✅":Math.floor(pct)+"%"}</b></div>
        <div class="barTrack"><div class="barFill" style="width:${pct}%;background:${o.done?"var(--leaf)":"var(--teal)"}"></div></div>`;
      list.appendChild(row);
    });
  }

  _openSelection(sel, silent){
    this.selected = sel;
    // A fresh (non-silent) tap on a patient or staff member locks the camera onto them, so the
    // player can watch them move through the hospital instead of losing track. Re-opening the
    // same panel via the live-refresh cycle (silent=true) doesn't re-trigger this, and it's
    // scoped to staff/patients only - tapping a room never moves the camera.
    if(!silent && (sel.kind==="staff" || sel.kind==="patient")){
      this.followTarget = {kind: sel.kind, id: sel.entity.id};
    }
    if(!silent) this.closeAllPanels();
    const panel = document.getElementById("panelSelection");
    const body = document.getElementById("selBody");
    // The room-assignment picker list gets fully rebuilt on every ~0.2s live-refresh tick (see
    // the bottom of this file), which used to reset its scroll position to the top on every
    // rebuild - making it impossible to scroll down to a room further in the list. Capture the
    // scroll offset (by id, since the element itself is about to be destroyed) before the
    // rebuild and restore it afterward.
    const prevRoomPickerScroll = document.getElementById("staffRoomPickerScroll")?.scrollTop || 0;
    if(sel.kind==="staff"){
      const s = sel.entity;
      document.getElementById("selName").textContent = s.def.symbol+" "+s.name;
      const specDef = s.specialty && SPECIALTIES[s.specialty];
      body.innerHTML = `
        <div class="statRow"><span class="label">Rank</span><b>${s.rankLabel}${specDef?` · ${s.specialty[0].toUpperCase()+s.specialty.slice(1)}`:""}</b></div>
        <div class="statRow"><span class="label">Skill</span><div class="barTrack"><div class="barFill" style="width:${s.skill}%;background:var(--teal)"></div></div></div>
        <div class="statRow"><span class="label">Energy</span><div class="barTrack"><div class="barFill" style="width:${s.energy}%;background:${s.energy<30?"var(--danger)":"var(--leaf)"}"></div></div></div>
        <div class="statRow"><span class="label">Thirst</span><div class="barTrack"><div class="barFill" style="width:${s.thirst||0}%;background:${(s.thirst||0)>75?"var(--danger)":"#4f8fb0"}"></div></div></div>
        <div class="statRow"><span class="label">Salary</span><b>${s.salary} $/day</b></div>
        <div class="statRow"><span class="label">Status</span><b>${this._staffStateLabel(s.state)}</b></div>
      `;
      // current assignment info - clickable, jumps straight to that room's own panel
      const curRoom = this.hospital.rooms.find(r=>r.id===s.assignedRoomId);
      const assignInfo = document.createElement("div");
      assignInfo.className="statRow";
      if(curRoom){
        assignInfo.innerHTML = `<span class="label">Assigned to</span>`;
        const chip = document.createElement("span");
        chip.className="roomLinkChip"; chip.textContent = ROOM_TYPES[curRoom.type].name;
        chip.addEventListener("click", ()=>this._openRoomInfo(curRoom));
        assignInfo.appendChild(chip);
      } else {
        assignInfo.innerHTML = `<span class="label">Assigned to</span><b>No room</b>`;
      }
      body.appendChild(assignInfo);

      // Handyman task queue (design feedback: "if he's called to room A then room B, he should
      // do A first, and I should be able to see/edit that list"). Shows what he's doing right
      // now plus anything queued up after it; each queued entry can be removed or promoted to
      // the front. The current job (repairRoomId/cleaningMessId) isn't itself in _taskQueue -
      // it's shown separately as "Currently" so the ordering reads top-to-bottom naturally.
      if(s.type==="maintenance"){
        const label = document.createElement("div");
        label.className="entityListLabel"; label.textContent="Task queue";
        body.appendChild(label);
        const currentRoom = s.repairRoomId ? this.hospital.rooms.find(r=>r.id===s.repairRoomId) : null;
        const currentRow = document.createElement("div");
        currentRow.className="statRow";
        if(currentRoom){
          currentRow.innerHTML = `<span class="label">Currently</span><b>🔧 Repairing ${ROOM_TYPES[currentRoom.type].name}</b>`;
        } else if(s.cleaningMessId){
          currentRow.innerHTML = `<span class="label">Currently</span><b>🧹 Cleaning up a mess</b>`;
        } else {
          currentRow.innerHTML = `<span class="label">Currently</span><b>Free</b>`;
        }
        body.appendChild(currentRow);
        const queue = s._taskQueue || [];
        if(queue.length===0){
          const empty = document.createElement("div");
          empty.style.cssText="font-size:11.5px;color:#999;padding:6px 2px;";
          empty.textContent = "Nothing queued up next.";
          body.appendChild(empty);
        } else {
          queue.forEach((task, i)=>{
            const room = this.hospital.rooms.find(r=>r.id===task.roomId);
            const row = document.createElement("div");
            row.className="entityRow";
            row.innerHTML = `<span class="ic">${i+1}</span><span class="nm">${room? ROOM_TYPES[room.type].name : "(room no longer exists)"}</span>`;
            const upBtn = document.createElement("button");
            upBtn.className="panelBtn ghost"; upBtn.textContent="↑"; upBtn.style.cssText="min-height:0;padding:4px 10px;";
            upBtn.disabled = i===0;
            upBtn.addEventListener("click", (ev)=>{
              ev.stopPropagation();
              [queue[i-1], queue[i]] = [queue[i], queue[i-1]];
              this._openSelection({kind:"staff",entity:s});
            });
            const rmBtn = document.createElement("button");
            rmBtn.className="panelBtn ghost"; rmBtn.textContent="✕"; rmBtn.style.cssText="min-height:0;padding:4px 10px;";
            rmBtn.addEventListener("click", (ev)=>{
              ev.stopPropagation();
              queue.splice(i,1);
              this._openSelection({kind:"staff",entity:s});
            });
            row.appendChild(upBtn); row.appendChild(rmBtn);
            row.style.cursor = "default";
            body.appendChild(row);
          });
        }
      }

      // room assignment picker - a custom inline list, not a native <select>. Its open/closed
      // state lives on the Game object (this._staffRoomPickerOpen) rather than in the DOM,
      // because this panel's body gets fully rebuilt every ~0.2s by the live-refresh system -
      // a native <select>'s open dropdown would get destroyed by that rebuild the instant it
      // opened, which is exactly the "closes as soon as it appears" bug this replaces.
      const compatibleRooms = this.hospital.rooms.filter(r=>{
        const def = ROOM_TYPES[r.type];
        return roleFitsRoom(s, def);
      });
      if(compatibleRooms.length>0){
        const btnRow = document.createElement("div");
        btnRow.className="panelBtnRow";
        if(this._staffRoomPickerOpen === s.id){
          const list = document.createElement("div");
          list.id = "staffRoomPickerScroll";
          list.style.cssText = "max-height:220px;overflow-y:auto;margin:8px 0;";
          compatibleRooms.forEach(r=>{
            const def = ROOM_TYPES[r.type];
            const cap = r.staffCapacity!=null ? r.staffCapacity : (def.capacity||1);
            const full = r.staffIds.length >= cap;
            const isCurrent = r.id===s.assignedRoomId;
            const notReady = r._constructing || r._demolishing;
            const el = document.createElement("div");
            el.className = "roomOption"+(isCurrent?" selected":"");
            if((full||notReady) && !isCurrent) el.style.opacity="0.5";
            const statusText = notReady? (r._constructing?"under construction":"being demolished") : (r.staffIds.length+"/"+cap+" staffed"+(full&&!isCurrent?" - full":""));
            el.innerHTML = `<div class="roomSwatch" style="background:${def.color}"></div>
              <div class="meta"><b>${def.name} (${r.w}×${r.h})</b><span>${statusText}</span></div>`;
            if((!full && !notReady) || isCurrent){
              el.addEventListener("click", ()=>{
                this.assignStaffToRoom(s.id, r.id);
                this._staffRoomPickerOpen = null;
                this._openSelection({kind:"staff",entity:s});
              });
            }
            list.appendChild(el);
          });
          body.appendChild(list);
          list.scrollTop = prevRoomPickerScroll;
          const closeBtn = document.createElement("button");
          closeBtn.className="panelBtn ghost"; closeBtn.textContent="Cancel";
          closeBtn.addEventListener("click", ()=>{ this._staffRoomPickerOpen=null; this._openSelection({kind:"staff",entity:s}); });
          btnRow.appendChild(closeBtn);
        } else {
          const assignBtn = document.createElement("button");
          assignBtn.className="panelBtn primary"; assignBtn.textContent="Assign to a room ▾";
          assignBtn.addEventListener("click", ()=>{ this._staffRoomPickerOpen = s.id; this._openSelection({kind:"staff",entity:s}); });
          const restBtn = document.createElement("button");
          restBtn.className="panelBtn ghost"; restBtn.textContent="Rest";
          restBtn.addEventListener("click", ()=>{ s.state="toRest"; s.path=null; this._openSelection({kind:"staff",entity:s}); });
          btnRow.appendChild(assignBtn); btnRow.appendChild(restBtn);
        }
        body.appendChild(btnRow);
      } else {
        const warn = document.createElement("div");
        warn.style.cssText="font-size:12px;color:#a55;margin:6px 0;";
        warn.textContent = "No compatible room built yet for this role.";
        body.appendChild(warn);
      }

      const fireRow = document.createElement("div");
      fireRow.className="panelBtnRow";
      const historyBtn = document.createElement("button");
      historyBtn.className="panelBtn ghost"; historyBtn.textContent="📜 History";
      historyBtn.addEventListener("click", ()=>this._openHistory(s, s.name));
      fireRow.appendChild(historyBtn);
      const fireBtn = document.createElement("button");
      fireBtn.className="panelBtn danger"; fireBtn.textContent="Fire";
      fireBtn.addEventListener("click", ()=>{
        this.staff = this.staff.filter(x=>x.id!==s.id);
        this.hospital.rooms.forEach(r=>{ r.staffIds = r.staffIds.filter(id=>id!==s.id); });
        document.getElementById("panelSelection").classList.remove("show");
        this.save();
      });
      fireRow.appendChild(fireBtn);
      body.appendChild(fireRow);
    } else {
      const p = sel.entity;
      document.getElementById("selName").textContent = "🧍 "+p.name+" (age "+p.age+")";
      const diagPct = clamp(p.diagnosisProgress/p.disease.diagnosisRequired*100, 0, 100);
      body.innerHTML = `
        <div class="statRow"><span class="label">Disease</span><b>${p.disease.symptom} ${p.disease.name}</b></div>
        <div class="statRow"><span class="label">Health</span><div class="barTrack"><div class="barFill" style="width:${p.health}%;background:${p.health<30?"var(--danger)":p.health<50?"var(--gold)":"var(--leaf)"}"></div></div></div>
        <div class="statRow"><span class="label">Mood</span><div class="barTrack"><div class="barFill" style="width:${p.happiness}%;background:var(--gold)"></div></div></div>
        <div class="statRow"><span class="label">Energy</span><div class="barTrack"><div class="barFill" style="width:${p.energy}%;background:${p.energy<25?"var(--danger)":"var(--teal)"}"></div></div></div>
        <div class="statRow"><span class="label">Thirst</span><div class="barTrack"><div class="barFill" style="width:${p.thirst}%;background:${p.thirst>75?"var(--danger)":"#4f8fb0"}"></div></div></div>
        <div class="statRow"><span class="label">Diagnosis</span><div class="barTrack"><div class="barFill" style="width:${diagPct}%;background:${p.diagnosed?"var(--leaf)":"var(--teal)"}"></div></div></div>
        <div class="statRow"><span class="label">Status</span><b>${this._patientStateLabel(p.state)}${p.seated?" (seated)":""}${p.priority?" ⭐":""}</b></div>
        ${p.health<30? `<div style="font-size:11px;color:var(--danger);margin-top:2px;">⚠ Critical - health dropping fast, needs priority care.</div>` : ""}
      `;
      // where they are / where they're heading, clickable to jump to that room's own panel
      const targetRoom = this.hospital.rooms.find(r=>r.id===p.targetRoomId);
      if(targetRoom){
        const roomRow = document.createElement("div");
        roomRow.className="statRow";
        roomRow.innerHTML = `<span class="label">Room</span>`;
        const chip = document.createElement("span");
        chip.className="roomLinkChip"; chip.textContent = ROOM_TYPES[targetRoom.type].name;
        chip.addEventListener("click", ()=>this._openRoomInfo(targetRoom));
        roomRow.appendChild(chip);
        body.appendChild(roomRow);
      }
      const inQueue = p.state && p.state.startsWith("queue");
      if(inQueue){
        const prioRow = document.createElement("div");
        prioRow.className="panelBtnRow";
        const prioBtn = document.createElement("button");
        prioBtn.className = "panelBtn "+(p.priority? "ghost":"primary");
        prioBtn.textContent = p.priority? "★ Prioritized" : "⭐ Move to front of queue";
        prioBtn.addEventListener("click", ()=>{ this.prioritizePatient(p); this._openSelection(sel); });
        prioRow.appendChild(prioBtn);
        body.appendChild(prioRow);
      }
      const histRow = document.createElement("div");
      histRow.className="panelBtnRow";
      const histBtn = document.createElement("button");
      histBtn.className="panelBtn ghost"; histBtn.textContent="📜 History";
      histBtn.addEventListener("click", ()=>this._openHistory(p, p.name));
      histRow.appendChild(histBtn);
      body.appendChild(histRow);
    }
    if(!silent) panel.classList.add("show");
  }

  // Shows the status-change log built up in _updatePatients/_updateStaff (entity._history) -
  // design feedback: "I should be able to see a history of status changes for a patient/staff".
  // Timestamps are shown relative to the current moment ("3m ago") rather than raw simTime,
  // since that's what's actually meaningful to a player mid-game.
  _openHistory(entity, name){
    // Remembered so the periodic UI refresh (see the bottom of this file) can keep this panel
    // live while it's open (design feedback: previously had to close and reopen it to see new
    // entries) instead of it going stale the moment something happens.
    this._historyOpenFor = entity;
    document.getElementById("historyName").textContent = name;
    const list = document.getElementById("historyList");
    list.innerHTML = "";
    const hist = entity._history || [];
    if(hist.length===0){
      list.innerHTML = '<div style="font-size:11.5px;color:#999;padding:14px 4px;text-align:center;">No history yet.</div>';
    } else {
      // newest first - the most recent change is the one a player checking in on someone cares
      // about most
      [...hist].reverse().forEach(entry=>{
        const secondsAgo = Math.max(0, this.simTime - entry.t);
        const row = document.createElement("div");
        row.className="statRow";
        row.innerHTML = `<span class="label">${this._formatAgo(secondsAgo)}</span><b>${entry.label}</b>`;
        list.appendChild(row);
      });
    }
    document.getElementById("panelHistory").classList.add("show");
  }
  // Converts a duration in sim-seconds to a short "Xm ago"/"Xh ago"/"just now" label, using the
  // same real-world-feeling day length the rest of the UI (like the room panel's "last patient"
  // stat) already converts through.
  _formatAgo(simSeconds){
    if(simSeconds<3) return "Just now";
    const hoursPerSimSecond = 24/this.dayLength;
    const hours = simSeconds*hoursPerSimSecond;
    if(hours<1) return Math.round(hours*60)+"m ago";
    if(hours<48) return Math.round(hours)+"h ago";
    return Math.round(hours/24)+"d ago";
  }

  // Player can't move patients directly (design doc §36), but can reorder the queue they're
  // already in - bumping someone critical to the front, same as the original's queue screen.
  prioritizePatient(p){
    const room = this.hospital.rooms.find(r=>r.id===p.targetRoomId);
    if(!room || !room.queue.includes(p.id)) return;
    room.queue = room.queue.filter(id=>id!==p.id);
    room.queue.unshift(p.id);
    p.priority = true;
    this.pushToast(p.name+" moved to the front of the queue.", "good");
  }

  _roleForRoom(def){
    // Preference order for *display* purposes only: a room's most specific/ideal staff role.
    // The underlying `needsDoctor` flag is what today's assignment/hiring logic actually reads
    // (see hireStaff / staff auto-assign), so it's left untouched here - needsNurse, needsSpecialty
    // and needsConsultant are structural metadata for the next pass, shown in the UI already so
    // the build catalogue reads correctly even before the deeper staffing logic is wired up.
    if(def.needsConsultant) return {label:"Consultant", symbol:"⚕"};
    if(def.needsSpecialty==="psychiatrist") return {label:"Psychiatrist", symbol:"⚕"};
    if(def.needsSpecialty==="researcher") return {label:"Doctor (Research)", symbol:"⚕"};
    if(def.needsNurse) return {label:"Nurse", symbol:"✚"};
    if(def.needsDoctor) return {label:"Doctor", symbol:"⚕"};
    if(def.needsReceptionist) return {label:"Receptionist", symbol:"☎"};
    if(def.needsResearcher) return {label:"Researcher", symbol:"🔬"};
    return null;
  }

  _openRoomInfo(room, silent){
    const def = ROOM_TYPES[room.type];
    this.selected = {kind:"room", entity:room};
    // Center the camera on the room (design feedback: opening a room's details - whether by
    // tapping it directly or via any other path, like the Rooms roster or a patient's target
    // room - should bring the view to it). Reuses the same smooth follow mechanism as
    // staff/patients; a room won't move, so it just settles there and stays.
    if(!silent) this.followTarget = {kind:"room", id:room.id};
    if(!silent) this.closeAllPanels();
    document.getElementById("selName").textContent = def.name;
    const body = document.getElementById("selBody");
    if(room._constructing){
      body.innerHTML = `
        <div class="statRow"><span class="label">Status</span><b>🚧 Under construction</b></div>
        <div class="statRow"><span class="label">Ready in</span><b>${Math.ceil(room._constructionTimer)}s</b></div>
      `;
      return;
    }
    if(room._demolishing){
      body.innerHTML = `
        <div class="statRow"><span class="label">Status</span><b>🧱 Being demolished</b></div>
        <div class="statRow"><span class="label">Gone in</span><b>${Math.ceil(room._demolishTimer)}s</b></div>
      `;
      return;
    }
    // "time since last patient" (design feedback: a quick way to spot a room nobody's using) -
    // converted from simTime seconds to in-game hours via dayLength/24, so it reads in units a
    // player actually thinks in rather than raw simulation seconds.
    const hoursPerSimSecond = 24/this.dayLength;
    const idleHoursText = room.lastServedAt==null
      ? (room.patientsServed>0 ? "-" : "Never")
      : Math.round((this.simTime-room.lastServedAt)*hoursPerSimSecond) + "h ago";
    if(room.type==="waitingRoom"){
      body.innerHTML = `
        <div class="statRow"><span class="label">Size</span><b>${room.w}×${room.h}</b></div>
        <div class="statRow"><span class="label">Seats</span><b>${(room.seatedIds||[]).length}/${room.seatCapacity}</b></div>
        <div class="statRow"><span class="label">Daily cost</span><b>${def.energyCost||0} $/day</b></div>
      `;
    } else {
      const role = this._roleForRoom(def);
      const cap = room.staffCapacity!=null ? room.staffCapacity : (def.capacity||0);
      const cond = Math.round(room.condition==null?100:room.condition);
      const condColor = cond<40? "var(--danger)" : cond<70? "var(--gold)" : "var(--leaf)";
      body.innerHTML = `
        <div class="statRow"><span class="label">Size</span><b>${room.w}×${room.h}</b></div>
        <div class="statRow"><span class="label">Waiting</span><b>${room.queue.length}</b></div>
        <div class="statRow"><span class="label">Patients served</span><b>${room.patientsServed||0}</b></div>
        <div class="statRow"><span class="label">Last patient</span><b>${idleHoursText}</b></div>
        <div class="statRow"><span class="label">Daily cost</span><b>${def.energyCost||0} $/day</b></div>
        <div class="statRow"><span class="label">Condition</span><div class="barTrack"><div class="barFill" style="width:${cond}%;background:${condColor}"></div></div></div>
        ${role? `<div class="statRow"><span class="label">Needs</span><b>${role.symbol} ${role.label}${def.surgeonsRequired>1?` ×${def.surgeonsRequired}`:""}</b></div>` : ""}
        ${cap>0? `<div class="statRow"><span class="label">Staffed</span><b>${room.staffIds.length}/${cap}</b></div>` : ""}
        ${def.machine && MACHINE_TYPES[def.machine]? `<div class="statRow"><span class="label">Equipment</span><b>🔧 ${MACHINE_TYPES[def.machine].name}</b></div>` : ""}
        ${room.machineDurability!=null? `<div class="statRow"><span class="label">${room.machineBroken? "⚠ Broken down":"Machine wear"}</span><div class="barTrack"><div class="barFill" style="width:${room.machineDurability}%;background:${room.machineBroken?"var(--danger)":room.machineDurability<30?"#e0973f":"var(--leaf)"}"></div></div></div>` : ""}
      `;
    }

    // clickable staff list - tapping any of them opens their own detail panel, useful for
    // browsing between related entities without hunting for them on the map
    const staffHere = this.staff.filter(s=>s.assignedRoomId===room.id);
    if(staffHere.length>0){
      const label = document.createElement("div");
      label.className="entityListLabel"; label.textContent="Staff here";
      body.appendChild(label);
      staffHere.forEach(s=>{
        const row = document.createElement("div");
        row.className="entityRow";
        row.innerHTML = `<span class="ic">${s.def.symbol}</span><span class="nm">${s.name}</span><span class="st">${this._staffStateLabel(s.state)}</span>`;
        row.addEventListener("click", ()=>this._openSelection({kind:"staff", entity:s}));
        body.appendChild(row);
      });
    }

    // clickable patient list - both those currently being served and those waiting in the queue
    const servedIds = new Set(this.staff.filter(s=>s.currentPatientId).map(s=>s.currentPatientId));
    const patientsHere = this.patients.filter(p=>
      p.targetRoomId===room.id && (room.queue.includes(p.id) || servedIds.has(p.id) || p.state==="beingConsulted" || p.state==="beingTreated")
    );
    if(patientsHere.length>0){
      const label = document.createElement("div");
      label.className="entityListLabel"; label.textContent="Patients here";
      body.appendChild(label);
      patientsHere.forEach(p=>{
        const row = document.createElement("div");
        row.className="entityRow";
        const beingServed = servedIds.has(p.id) || p.state==="beingConsulted" || p.state==="beingTreated";
        row.innerHTML = `<span class="ic">${p.disease.symptom}</span><span class="nm">${p.name}</span><span class="st">${beingServed? "being seen" : "waiting"}</span>`;
        row.addEventListener("click", ()=>this._openSelection({kind:"patient", entity:p}));
        body.appendChild(row);
      });
    }

    // "Customize" (design feedback: some way to personalize a built room - windows, moving
    // furniture, etc). Windows are the part actually implemented so far: a toggle per wall,
    // purely cosmetic. Only offered once the room is actually finished being placed.
    if(!room._constructing && !room._demolishing){
      const custLabel = document.createElement("div");
      custLabel.className="entityListLabel"; custLabel.textContent="Customize";
      body.appendChild(custLabel);
      const custRow = document.createElement("div");
      custRow.style.cssText = "display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;";
      room.windows = room.windows || {north:false, south:false, east:false, west:false};
      [["north","N wall"],["west","W wall"],["south","S wall"],["east","E wall"]].forEach(([side,label])=>{
        const wBtn = document.createElement("button");
        wBtn.className = "panelBtn "+(room.windows[side]?"primary":"ghost");
        wBtn.style.cssText = "flex:1;min-width:70px;font-size:11.5px;padding:8px 4px;";
        wBtn.textContent = (room.windows[side]?"🪟 ":"▢ ")+label;
        wBtn.addEventListener("click", ()=>{
          this.toggleRoomWindow(room, side);
          this._openRoomInfo(room, true);
        });
        custRow.appendChild(wBtn);
      });
      body.appendChild(custRow);
      // Furniture position nudge (design feedback: "déplacer le mobilier") - shifts the whole
      // desk/machine/bed arrangement a little within the room, and where staff/patients
      // actually stand to use it moves right along with it (see staffSlotWorld/
      // patientSlotWorld), so it never looks like furniture floating away from the person using it.
      if(def.furniture){
        const furnLabel = document.createElement("div");
        furnLabel.className="entityListLabel"; furnLabel.textContent="Furniture position";
        body.appendChild(furnLabel);
        const furnRow = document.createElement("div");
        furnRow.style.cssText = "display:flex;gap:6px;align-items:center;justify-content:center;margin-bottom:10px;";
        const step = 0.07;
        const mkNudgeBtn = (label, dx, dy)=>{
          const b = document.createElement("button");
          b.className="panelBtn ghost"; b.textContent=label;
          b.style.cssText="min-width:38px;min-height:38px;padding:6px;font-size:15px;";
          b.addEventListener("click", ()=>{ this.nudgeRoomFurniture(room, dx, dy); this._openRoomInfo(room, true); });
          return b;
        };
        furnRow.appendChild(mkNudgeBtn("◀", -step, 0));
        const vCol = document.createElement("div");
        vCol.style.cssText="display:flex;flex-direction:column;gap:4px;";
        vCol.appendChild(mkNudgeBtn("▲", 0, -step));
        vCol.appendChild(mkNudgeBtn("▼", 0, step));
        furnRow.appendChild(vCol);
        furnRow.appendChild(mkNudgeBtn("▶", step, 0));
        const resetBtn = document.createElement("button");
        resetBtn.className="panelBtn ghost"; resetBtn.textContent="Reset";
        resetBtn.style.cssText="min-height:38px;font-size:11.5px;margin-left:6px;padding:6px 10px;";
        resetBtn.addEventListener("click", ()=>{
          room.furnitureOffset = {dx:0, dy:0};
          this.save();
          this._openRoomInfo(room, true);
        });
        furnRow.appendChild(resetBtn);
        body.appendChild(furnRow);
      }
    }

    const btnRow = document.createElement("div");
    btnRow.className="panelBtnRow";
    // "Call handyman to repair" (design feedback: no direct way to request a repair - had to
    // wait for a janitor to get around to it on their own priority pass). Only offered when
    // there's actually something to fix, and reuses the exact same toRepair/repairing staff
    // states a janitor would use on their own - this just jumps the queue for this one room.
    if(!room._constructing && !room._demolishing && ((room.condition??100)<100 || room.machineBroken || (room.machineDurability!=null && room.machineDurability<100))){
      const repairBtn = document.createElement("button");
      repairBtn.className="panelBtn ghost";
      repairBtn.textContent = "🔧 Call handyman to repair";
      repairBtn.addEventListener("click", ()=>{ this.callHandymanTo(room); });
      btnRow.appendChild(repairBtn);
    }
    const delBtn = document.createElement("button");
    delBtn.className="panelBtn danger";
    delBtn.textContent = "🗑 Demolish";
    delBtn.addEventListener("click", ()=>{
      this.showConfirm("Demolish this "+def.name+"? Staff will be freed and anyone using it will be sent out.", ()=>{
        this.deleteRoom(room.id);
      });
    });
    btnRow.appendChild(delBtn);
    body.appendChild(btnRow);
    if(!silent) document.getElementById("panelSelection").classList.add("show");
  }

  // Dispatches an available handyman to repair a specific room right now, instead of waiting
  // for their own worst-condition-first patrol logic to eventually get to it. Prefers a
  // genuinely idle handyman; if every handyman is already busy, queues it as their very next
  // stop once they finish their current job (see the janitor task list, _handymanQueue).
  callHandymanTo(room){
    // Maintenance staff don't have a "home desk" (assignedRoomId is null - they roam and
    // respond to whatever needs doing), so they never actually reach atSlot=true the way a
    // doctor or nurse would; state==="idle" alone is the correct "free and waiting for a task"
    // signal for this role.
    const idleJanitor = this.staff.find(s=>s.type==="maintenance" && s.state==="idle" && !s.repairRoomId && !s.cleaningMessId);
    if(idleJanitor){
      idleJanitor.repairRoomId = room.id;
      idleJanitor.setPathToTile(this.hospital, room.door.x, room.door.y);
      idleJanitor.state = "toRepair";
      idleJanitor.atSlot = false;
      this.pushToast(idleJanitor.name+" is on the way to fix it.", "good");
      return;
    }
    const anyJanitor = this.staff.find(s=>s.type==="maintenance");
    if(!anyJanitor){ this.pushToast("No handyman hired - hire one from Staff first.", "bad"); return; }
    // every handyman is busy - add to the front of whichever one's task queue so it's handled
    // as soon as their current job wraps up (see the janitor task list panel)
    anyJanitor._taskQueue = anyJanitor._taskQueue || [];
    anyJanitor._taskQueue.unshift({type:"repair", roomId:room.id});
    this.pushToast("Every handyman is busy - "+anyJanitor.name+" will head there next.", "good");
  }
  // Toggles a window on one wall of a room (see the room detail panel's "Customize" section) -
  // purely cosmetic (see pushWallDecor), only meaningfully visible on the north/west walls
  // since south/east are hidden by the camera by default the same way room decor already is.
  toggleRoomWindow(room, side){
    room.windows = room.windows || {north:false, south:false, east:false, west:false};
    room.windows[side] = !room.windows[side];
    this.save();
  }
  // Nudges the whole furniture arrangement (and where staff/patients actually stand to use it -
  // see staffSlotWorld/patientSlotWorld) a little in one direction (see the room detail panel's
  // "Customize" section) - clamped to a modest range so it always stays believably inside the
  // room regardless of how many times the player pushes it the same way.
  nudgeRoomFurniture(room, dx, dy){
    room.furnitureOffset = room.furnitureOffset || {dx:0, dy:0};
    room.furnitureOffset.dx = clamp(room.furnitureOffset.dx+dx, -0.28, 0.28);
    room.furnitureOffset.dy = clamp(room.furnitureOffset.dy+dy, -0.28, 0.28);
    // slot indices don't change, but a staff/patient mid-walk toward the old spot should
    // retarget toward the new one rather than finishing their approach to a now-stale position
    this.staff.forEach(s=>{ if(s.assignedRoomId===room.id && (s.state==="toWork"||s.state==="enteringRoom")) s.path=null; });
    this.save();
  }

  deleteRoom(roomId){
    const room = this.hospital.rooms.find(r=>r.id===roomId);
    if(!room || room._demolishing) return;
    const def = ROOM_TYPES[room.type];
    this.staff.forEach(s=>{
      if(s.assignedRoomId===roomId){
        s.assignedRoomId=null; s.atSlot=false; s.state="idle"; s.workPhase=null; s.path=null; s.currentPatientId=null;
      }
    });
    this.patients.forEach(p=>{
      if(p.targetRoomId===roomId || p.waitingRoomId===roomId || p.recallRoomId===roomId || p.exitRoomId===roomId){
        p.waitingRoomId=null; p.seatIndex=-1; p.seated=false;
        p.assistingStaffIds = []; p._teamSkill = null;
        if(p.state!=="leaving" && p.state!=="gone"){ p.state="leaving"; this._sendToExit(p); }
      }
    });
    room.staffIds = []; room.queue = [];
    // Demolition normally takes a few seconds so it can't be used to instantly free up space
    // mid-game - but during the initial setup phase (before the player has pressed ▶ and
    // patients start arriving), there's no gameplay reason to make them wait: they're just
    // repositioning a room they haven't even started using yet.
    if(!this.hasStartedPlaying){
      this.hospital.rooms = this.hospital.rooms.filter(r=>r.id!==roomId);
      this.hospital._rebuildBlocked();
      this.economy.earn(Math.floor(def.cost*0.4));
      this.pushToast(def.name+" demolished.", "good");
      this.closeAllPanels();
      this.save();
      return;
    }
    room._demolishing = true;
    room._demolishTimer = CONSTRUCTION_SECONDS;
    this.economy.earn(Math.floor(def.cost*0.4)); // partial refund
    this.pushToast(def.name+" being demolished ("+CONSTRUCTION_SECONDS+"s)...", "good");
    this.closeAllPanels();
    this.save();
  }

  // Ticks every constructing/demolishing room's timer, and completes them once done: a fresh
  // build becomes usable (and only now triggers the queue-rebalance to a second same-type
  // room, since a queue shouldn't be redirected to a room that isn't actually open yet); a
  // demolition actually disappears from hospital.rooms and frees the nav grid.
  _updateConstruction(dt){
    for(const room of this.hospital.rooms){
      if(room._constructing){
        room._constructionTimer -= dt;
        if(room._constructionTimer<=0){
          room._constructing = false;
          this.pushToast(ROOM_TYPES[room.type].name+" is ready!", "good");
          this._rebalanceQueuesAfterBuild(room);
        }
      } else if(room._demolishing){
        room._demolishTimer -= dt;
        if(room._demolishTimer<=0){
          this.hospital.rooms = this.hospital.rooms.filter(r=>r.id!==room.id);
          this.hospital._rebuildBlocked();
        }
      }
    }
  }

  _staffStateLabel(s){
    return {idle:"Available", toWork:"On the way", working:"Working", toRest:"Heading to rest", resting:"Resting"}[s]||s;
  }
  _patientStateLabel(s){
    return {
      arriving:"Arriving", toReception:"Heading to reception", queueReception:"Waiting at reception",
      toConsult:"Heading to consultation", queueConsult:"Waiting for doctor", beingConsulted:"In consultation",
      toTreatment:"Heading to treatment", queueTreatment:"Waiting for treatment", beingTreated:"Being treated",
      toWaitingRoom:"Heading to waiting room", beingRecalled:"Called back from waiting room",
      walkOut:"Leaving the room", leaving:"Leaving", gone:"Gone",
      awaitingDecision:"Waiting on your decision", waitingForRoom:"Waiting for a room to be built"
    }[s]||s;
  }
  // Fires the "new condition discovered" choice modal (design feedback) the first time a
  // patient is diagnosed with a disease whose treatment room doesn't exist at all yet - not
  // for a room that merely isn't staffed right now, which is a softer, more routine problem the
  // existing "left unpaid" flow already covers. Only asks once per missing room type per game;
  // returns true if it actually triggered (so the caller can freeze this patient's progress
  // until the choice is made), false if there's nothing new to ask about.
  // Animates each room's (and the hospital entrance's) door leaf open/closed based on whether
  // anyone is actually near it right now (design feedback: materialize the doors, and have them
  // open when someone wants to pass through) - a simple proximity check each frame, eased toward
  // the target so it reads as a real door swinging rather than an instant cut.
  _updateDoors(dt){
    const thresholdSq = (TILE*1.6)*(TILE*1.6);
    const openSpeed = 5;
    const movers = [];
    for(const s of this.staff){ if(s.state!=="gone") movers.push(s); }
    for(const p of this.patients){ if(p.state!=="gone" && p.state!=="dead") movers.push(p); }
    for(const r of this.hospital.rooms){
      if(r._constructing || r._demolishing || !r.door) continue;
      const doorWX=(r.door.x+0.5)*TILE, doorWY=(r.door.y+0.5)*TILE;
      let near = false;
      for(const e of movers){
        const dx=e.x-doorWX, dy=e.y-doorWY;
        if(dx*dx+dy*dy < thresholdSq){ near=true; break; }
      }
      r._doorOpenAmount = r._doorOpenAmount==null ? 0 : r._doorOpenAmount;
      const target = near ? 1 : 0;
      r._doorOpenAmount = clamp(r._doorOpenAmount + clamp(target-r._doorOpenAmount, -openSpeed*dt, openSpeed*dt), 0, 1);
    }
    const ent = this.hospital.entranceTile();
    const entWX=(ent.x+0.5)*TILE, entWY=(ent.y+0.5)*TILE;
    let entNear = false;
    for(const e of movers){
      const dx=e.x-entWX, dy=e.y-entWY;
      if(dx*dx+dy*dy < thresholdSq){ entNear=true; break; }
    }
    this.hospital._entranceDoorOpenAmount = this.hospital._entranceDoorOpenAmount==null ? 0 : this.hospital._entranceDoorOpenAmount;
    const entTarget = entNear ? 1 : 0;
    this.hospital._entranceDoorOpenAmount = clamp(this.hospital._entranceDoorOpenAmount + clamp(entTarget-this.hospital._entranceDoorOpenAmount, -openSpeed*dt, openSpeed*dt), 0, 1);
  }

  // Fires the "new condition discovered" choice modal (design feedback) the first time a
  // patient is diagnosed with a disease whose treatment room doesn't exist at all yet - not
  // for a room that merely isn't staffed right now, which is a softer, more routine problem the
  // existing "left unpaid" flow already covers. Only asks once per missing room type per game;
  // returns true if it actually triggered (so the caller can freeze this patient's progress
  // until the choice is made), false if there's nothing new to ask about.
  _maybeAskAboutMissingRoom(p){
    if(this._activeChoiceModal) return false; // one decision at a time
    const roomType = p.disease.room;
    if(this.hospital.roomsOfType(roomType).length > 0) return false; // room exists - a staffing gap, not a missing room
    this._missingRoomAcknowledged = this._missingRoomAcknowledged || new Set();
    if(this._missingRoomAcknowledged.has(roomType)) return false;
    this._missingRoomAcknowledged.add(roomType);
    this._activeChoiceModal = true;
    const roomName = ROOM_TYPES[roomType] ? ROOM_TYPES[roomType].name : roomType;
    this.showChoice(
      "New condition discovered",
      "Your team has discovered a new condition: "+p.disease.name+". You must build a "+roomName+" to be able to deal with this. What do you want to do with "+p.name+"?",
      [
        { label:"Send patient home", cls:"danger", action:()=>{
          this._activeChoiceModal = false;
          this.hospitalReputation = clamp(this.hospitalReputation-3, 0, 100);
          this.pushToast(p.name+" was sent home.", "bad");
          this._logHistory(p, "🏠 Sent home - no "+roomName+" built yet");
          if(p.state==="awaitingDecision"){ p.state="leaving"; this._sendToExit(p); }
        }},
        { label:"Let them wait at the hospital", cls:"primary", action:()=>{
          this._activeChoiceModal = false;
          this.pushToast(p.name+" will wait for the "+roomName+" to be built.", "good");
          this._logHistory(p, "⏳ Waiting for a "+roomName+" to be built");
          if(p.state==="awaitingDecision"){ p.state="waitingForRoom"; p._waitingReason="treatment"; }
        }}
      ]
    );
    return true;
  }
  // Fires the "we've run out of diagnostic capacity" choice modal the moment a patient hits
  // the diagnosis-attempt cap without ever reaching full confidence - same one-shot-per-decision
  // gating (this._activeChoiceModal) as the missing-room case above, but this one is per-patient
  // rather than per-disease since it's specifically about THIS patient's own diagnosis, not a
  // structural gap in the hospital.
  _maybeAskAboutExhaustedDiagnosis(p){
    if(this._activeChoiceModal) return false;
    this._activeChoiceModal = true;
    const confidencePct = Math.round(clamp(p.diagnosisProgress / p.disease.diagnosisRequired, 0.35, 0.95)*100);
    const roomName = ROOM_TYPES[p.disease.room] ? ROOM_TYPES[p.disease.room].name : p.disease.room;
    this.showChoice(
      "Diagnosis inconclusive",
      "We have exhausted all our diagnosis machines on "+p.name+" and we are still not sure what is wrong. There is a "+confidencePct+"% chance that we have correctly identified the condition. What shall we do with the patient?",
      [
        { label:"Send patient home", cls:"danger", action:()=>{
          this._activeChoiceModal = false;
          this.hospitalReputation = clamp(this.hospitalReputation-3, 0, 100);
          this.pushToast(p.name+" was sent home.", "bad");
          this._logHistory(p, "🏠 Sent home - diagnosis inconclusive");
          if(p.state==="awaitingDecision"){ p.state="leaving"; this._sendToExit(p); }
        }},
        { label:"Take a chance on the cure", cls:"primary", action:()=>{
          this._activeChoiceModal = false;
          p.diagnosisConfidence = clamp(p.diagnosisProgress / p.disease.diagnosisRequired, 0.35, 0.95);
          p.happiness -= 8;
          this._logHistory(p, "🎲 Proceeding to treatment on a "+confidencePct+"% guess");
          if(p.state==="awaitingDecision"){
            p.exitAfter = {type:"toRoom", roomType:p.disease.room, nextState:"toTreatment"};
            p.state="walkOut";
          }
        }},
        { label:"Wait while more diagnosis rooms are built", cls:"ghost", action:()=>{
          this._activeChoiceModal = false;
          this.pushToast(p.name+" will wait for more diagnostic equipment.", "good");
          this._logHistory(p, "⏳ Waiting for more diagnostic rooms");
          if(p.state==="awaitingDecision"){ p.state="waitingForRoom"; p._waitingReason="diagnosis"; }
        }}
      ]
    );
    return true;
  }
  _logHistory(entity, label){
    entity._history = entity._history || [];
    entity._history.push({ t:this.simTime, label });
    if(entity._history.length>60) entity._history.shift();
  }

  /* ---------------- game logic update ---------------- */
  update(dt){
    if(this.paused) return;
    const simDt = dt*this.speedMult;
    this.simTime += simDt;
    if(this.simTime >= this.day*this.dayLength){
      this._onNewDay();
    }
    this._updateStaff(simDt);
    this._updatePatients(simDt);
    this._updateResearch(simDt);
    this._updateTraining(simDt);
    this._maybeTriggerEmergency(simDt);
    this._updateDoors(simDt);
    this._updateConstruction(simDt);
    this._spawnLogic(simDt);
    this._checkWarnings(simDt);
    this._updateFloatingTexts(dt); // real time, not sim time - readable at any game speed
    this._sampleStats(simDt);
    this._applyStaffLeaveRoomsPolicy(simDt);
  }

  // Staff Leave Rooms policy (Theme Hospital's policy screen): when ON, an idle staff member
  // whose own room barely has a queue can be pulled to help wherever the queue is worst, among
  // rooms needing the same skill. Cuts down on how many staff you need overall, at the cost of
  // staff constantly rotating between rooms (their own downside, straight from the description).
  _applyStaffLeaveRoomsPolicy(dt){
    if(!this.policy.staffLeaveRooms) return;
    this._policyRebalanceTimer = (this._policyRebalanceTimer||0) + dt;
    if(this._policyRebalanceTimer < 6) return;
    this._policyRebalanceTimer = 0;
    // One shared pool across every staffed room type (Operating Theatre excluded - pulling one
    // of its 2 required surgeons mid-team would strand the other). roleFitsRoom is what actually
    // keeps a Psychiatrist from getting redirected to a generic Consultation queue, etc., so a
    // single pool is safe now that eligibility is properly role-aware.
    const pool = this.hospital.rooms.filter(r=>{
      const def = ROOM_TYPES[r.type];
      return (def.needsDoctor || def.needsReceptionist || def.needsNurse) && !(def.surgeonsRequired>1);
    });
    if(pool.length<2) return;
    const roomCap = r=> r.staffCapacity!=null ? r.staffCapacity : (ROOM_TYPES[r.type].capacity||1);
    const needy = pool
      .filter(r=>r.queue.length>=3 && r.staffIds.length<roomCap(r))
      .sort((a,b)=>b.queue.length-a.queue.length)[0];
    if(!needy) return;
    const needyDef = ROOM_TYPES[needy.type];
    for(const donor of pool){
      if(donor.id===needy.id || donor.queue.length>1) continue;
      const idleStaff = this.staff.find(s=>s.assignedRoomId===donor.id && s.state==="idle" && s.atSlot && roleFitsRoom(s, needyDef));
      if(idleStaff){
        this.assignStaffToRoom(idleStaff.id, needy.id, true);
        break;
      }
    }
  }

  // Rolling samples for the health/patients/reputation trend charts (separate from the
  // day-granularity econ history, since these fluctuate faster and look better as a smooth line)
  _sampleStats(dt){
    this._statsSampleTimer = (this._statsSampleTimer||0) + dt;
    if(this._statsSampleTimer < 3) return;
    this._statsSampleTimer = 0;
    this.statsHistory.push({
      t: this.simTime,
      health: this.avgHealth(),
      patients: this.patients.filter(p=>p.state!=="dead").length,
      reputation: Math.round(this.hospitalReputation),
      money: Math.round(this.economy.money)
    });
    if(this.statsHistory.length > 80) this.statsHistory.shift();
  }

  _spawnFloatingText(worldX, worldY, text, color, kind){
    this.floatingTexts.push({ x:worldX, y:worldY, text, color, age:0, duration:1.6, kind:kind||"text" });
  }
  _updateFloatingTexts(dt){
    for(const f of this.floatingTexts) f.age += dt;
    this.floatingTexts = this.floatingTexts.filter(f=>f.age < f.duration);
  }
  // Emergencies (design doc §29): a batch of patients sharing one disease arrives at once, with
  // a time limit and a lump-sum reward if the hospital cures the whole group before it expires.
  // Only triggers for a disease the hospital can actually treat right now (room built + staffed)
  // so it's a real, completable challenge rather than a trap. Un-cured patients aren't killed
  // when the clock runs out - they just fall back to being ordinary patients and the bonus is
  // lost, matching the spec's "reward if successful" framing rather than a punishment mechanic.
  // Single source of truth for "how far into the difficulty curve are we" (design feedback:
  // difficulty should keep evolving over time - more/harder diseases, more frequent
  // emergencies/events, more patients - not plateau early). 0 at day 6 (when emergencies first
  // become possible), climbing to 1 around day 46, kept available past that for anything that
  // wants to keep scaling slowly forever rather than hard-capping.
  _difficultyProgress(){
    return clamp((this.day-6)/40, 0, 1);
  }
  _maybeTriggerEmergency(dt){
    if(this.activeEmergency){
      const em = this.activeEmergency;
      em.timeLeft -= dt;
      if(em.curedCount >= em.total){
        this.economy.earn(em.reward);
        this.hospitalReputation = clamp(this.hospitalReputation + 8, 0, 100);
        this.pushToast("🚨 Emergency handled! +$"+em.reward+" and a reputation boost.", "good");
        this.activeEmergency = null;
      } else if(em.timeLeft <= 0){
        // Partial credit (design feedback: an all-or-nothing timeout was too punishing and was
        // the single biggest drain on reputation) - some money and a much gentler reputation
        // hit for whatever fraction actually got cured in time, instead of losing everything
        // for finishing at, say, 4/5.
        const fraction = em.curedCount/em.total;
        const partialReward = Math.round(em.reward * fraction * 0.5);
        if(partialReward>0) this.economy.earn(partialReward);
        const repDelta = em.curedCount>0 ? -1.5 : -3;
        this.hospitalReputation = clamp(this.hospitalReputation + repDelta, 0, 100);
        this.pushToast(em.curedCount>0
          ? ("🚨 Emergency time limit passed - partial credit for "+em.curedCount+"/"+em.total+" treated (+$"+partialReward+").")
          : "🚨 Emergency time limit passed - the bonus reward is lost.", "bad");
        em.patientIds.forEach(id=>{
          const p = this.patients.find(x=>x.id===id);
          if(p) p.isEmergency = false;
        });
        this.activeEmergency = null;
      }
      return;
    }
    this._emergencyCooldown = (this._emergencyCooldown||0) - dt;
    if(this._emergencyCooldown > 0) return;
    // Cooldown shrinks and the fire-chance grows as the days pass (design feedback: exceptional
    // events should get more frequent over time, not stay flat forever past the initial ramp-in).
    const diff = this._difficultyProgress();
    this._emergencyCooldown = lerp(300, 130, diff) + Math.random()*100;
    if(this.day < 6) return; // give the player more time to get the basics running first
    if(Math.random() > lerp(0.2, 0.45, diff)) return; // not every check window actually fires one
    const recRooms = this.hospital.roomsOfType("reception");
    if(recRooms.length===0 || this.patients.length>14) return;
    // only diseases whose treatment room is actually built AND staffed - an emergency for a
    // room the player hasn't built yet would be unwinnable and just feel unfair
    const candidates = this._availableDiseaseKeys().filter(k=>{
      const room = this._findAvailableRoomWithStaff(DISEASES[k].room);
      return !!room;
    });
    if(!candidates.length) return;
    const diseaseKey = candidates[Math.floor(Math.random()*candidates.length)];
    const disease = DISEASES[diseaseKey];
    // Emergencies represent a known, already-identified incident (a bus crash, a gas leak) -
    // not a diagnostic mystery, so unlike regular patients these arrive pre-diagnosed and walk
    // straight to the treatment room, skipping reception/consultation entirely. Previously they
    // spawned exactly like a normal patient and had to clear the full diagnosis pipeline (GP,
    // maybe a second diagnostic room) before even reaching a single-capacity treatment room,
    // all within the time limit - which made most emergencies essentially unwinnable and was
    // the single biggest drain on hospital reputation (a -6 penalty on every near-guaranteed
    // timeout). Batch size trimmed slightly too, since a single-capacity room still has to see
    // everyone one at a time.
    const total = 3 + Math.floor(Math.random()*2); // 3-4 patients (was 3-6, then 3-5 - even a
    // diagnosis-free arrival still has to funnel through a single-capacity room one at a time)
    const targetRoom = this._findAvailableRoomWithStaff(disease.room) || this.hospital.roomsOfType(disease.room)[0];
    const ids = [];
    for(let i=0;i<total;i++){
      const p = new Patient(this.hospital, diseaseKey);
      p.isEmergency = true;
      p.diagnosed = true;
      p.diagnosisProgress = disease.diagnosisRequired;
      p.diagnosisConfidence = 1;
      if(targetRoom){
        p.targetRoomId = targetRoom.id;
        const door = this.hospital.doorWorld(targetRoom);
        p.setPathToTile(this.hospital, Math.floor(door.x/TILE), Math.floor(door.y/TILE));
        p.state = "toTreatment";
      }
      this.patients.push(p);
      ids.push(p.id);
    }
    this.activeEmergency = {
      id: uid(), diseaseKey, total, curedCount:0,
      timeLeft: 180 + Math.random()*60, timeLimit: 180,
      reward: Math.round(disease.reward * total * 0.9),
      patientIds: ids
    };
    this.pushToast("🚨 Emergency! "+total+" patients with "+disease.name+" just arrived - cure them all before time runs out for a big bonus.", "bad");
  }
  _checkWarnings(dt){
    this._warnTimer = (this._warnTimer||0) + dt;
    if(this._warnTimer < 2.5) return;
    this._warnTimer = 0;

    const QUEUE_WARN = 4;
    const newAlerts = new Map();

    for(const r of this.hospital.rooms){
      if(r.queue.length >= QUEUE_WARN){
        const key = "queue:"+r.id;
        newAlerts.set(key, { icon:"⏳", text: ROOM_TYPES[r.type].name+" has a long queue ("+r.queue.length+" waiting)." });
        if(!this.activeAlerts.has(key)){
          this.pushToast("⚠ Long wait building up at "+ROOM_TYPES[r.type].name+"!", "bad");
        }
      }
      if(r.machineBroken){
        const key = "brokenMachine:"+r.id;
        const machine = MACHINE_TYPES[ROOM_TYPES[r.type].machine];
        newAlerts.set(key, { icon:"🔧", text:(machine?machine.name:"Equipment")+" in "+ROOM_TYPES[r.type].name+" is broken - send a handyman." });
      }
    }

    const veryUnhappy = this.patients.filter(p=>p.happiness<20).length;
    if(veryUnhappy>=2){
      const key="mood:global";
      newAlerts.set(key, { icon:"😠", text: veryUnhappy+" patients are very unhappy and may leave." });
      if(!this.activeAlerts.has(key)){
        this.pushToast("⚠ Several patients are getting very upset!", "bad");
      }
    }

    const understaffed = this.hospital.rooms.filter(r=>{
      const def = ROOM_TYPES[r.type];
      return (def.needsDoctor||def.needsResearcher) && r.staffIds.length===0;
    });
    if(understaffed.length>0){
      newAlerts.set("understaffed", { icon:"🚪", text: understaffed.length+" room(s) have no staff assigned." });
    }

    if(this.economy.money<0){
      newAlerts.set("cash", { icon:"💸", text:"Cash flow is negative - reduce expenses." });
    }

    if(this.activeEmergency){
      const em = this.activeEmergency;
      newAlerts.set("emergency", { icon:"🚨", text:"Emergency in progress: "+em.curedCount+"/"+em.total+" "+DISEASES[em.diseaseKey].name+" patients cured, "+Math.max(0,Math.ceil(em.timeLeft))+"s left." });
    }

    // suggest specific rooms to build, based on what current patients actually need but
    // can't get to - a direct nod to the design doc's system-interaction philosophy: an
    // untreatable disease is usually a missing-room problem, not a staffing problem
    const missingByType = new Map();
    for(const p of this.patients){
      if(p.state==="leaving" || p.state==="gone" || p.state==="dead") continue;
      const roomType = p.disease.room;
      if(this.hospital.roomsOfType(roomType).length===0){
        const label = ROOM_TYPES[roomType].name;
        missingByType.set(roomType, (missingByType.get(roomType)||0)+1);
      }
    }
    for(const [roomType, count] of missingByType){
      const key = "needRoom:"+roomType;
      newAlerts.set(key, { icon:"🏗", text: count+" patient(s) need a "+ROOM_TYPES[roomType].name+" - none built yet." });
      if(!this.activeAlerts.has(key)){
        this.pushToast("🏗 Patients need a "+ROOM_TYPES[roomType].name+" - consider building one.", "bad");
      }
    }
    if(this.hospital.roomsOfType("consultation").length===0 && this.patients.length>0){
      const key = "needRoom:consultation";
      newAlerts.set(key, { icon:"🏗", text:"No Consultation Room - nobody can be diagnosed." });
      if(!this.activeAlerts.has(key)){
        this.pushToast("🏗 You need a Consultation Room before anyone can be treated!", "bad");
      }
    }

    // thirst: patients/staff who got stuck at 100% thirst because there's simply no fountain
    // anywhere in the hospital - a build-a-fountain nudge, not a per-person spam of alerts
    const thirstyPatients = this.patients.filter(p=>p.thirst>=90 && p.state!=="leaving" && p.state!=="gone" && p.state!=="dead").length;
    const thirstyStaff = this.staff.filter(s=>s.thirst>=90).length;
    if((thirstyPatients>0 || thirstyStaff>0) && this.hospital.objects.filter(o=>o.type==="fountain").length===0){
      const key = "noWater";
      newAlerts.set(key, { icon:"🚰", text: (thirstyPatients+thirstyStaff)+" people are very thirsty - no water fountain anywhere. Place one from the Furniture tab." });
      if(!this.activeAlerts.has(key)){
        this.pushToast("🚰 People are thirsty and there's no fountain in the hospital!", "bad");
      }
    }
    this._noWaterWarning = false;

    this.activeAlerts = newAlerts;
    const n = this.activeAlerts.size;
    const btn = document.getElementById("alertsBtn");
    document.getElementById("alertsCount").textContent = n;
    btn.classList.toggle("show", n>0);
  }

  _refreshAlertsPanel(){
    const list = document.getElementById("alertsList");
    list.innerHTML = "";
    if(this.activeAlerts.size===0){
      list.innerHTML = '<div style="font-size:12.5px;color:#666;">No active alerts. Everything looks fine!</div>';
      return;
    }
    for(const [key,a] of this.activeAlerts){
      const row = document.createElement("div");
      row.className="alertRow";
      row.innerHTML = `<span class="ic">${a.icon}</span><span>${a.text}</span>`;
      list.appendChild(row);
    }
  }

  // Training Room (design doc §26): a Consultant teaches any Junior/Doctor-rank colleagues
  // sharing the room, raising their skillPoints (and therefore their rank, see rankForSkill)
  // over time. Rate depends on the trainer's own skill, is diluted across however many students
  // are present, and slows down for a tired student - matching "skill du formateur, skill de
  // l'élève, nombre d'élèves, fatigue, spécialisation" from the spec. No consultant present -
  // no training happens, same as an empty classroom.
  _updateTraining(dt){
    const trainingRooms = this.hospital.roomsOfType("trainingRoom");
    for(const room of trainingRooms){
      const present = room.staffIds
        .map(id=>this.staff.find(s=>s.id===id))
        .filter(s=>s && s.state==="idle" && s.atSlot);
      const trainer = present.find(s=>s.rank==="consultant");
      if(!trainer) continue;
      const students = present.filter(s=>s!==trainer && s.skillPoints<1000);
      if(!students.length) continue;
      const perStudentRate = (2 + trainer.skillPoints/200) / students.length * (this.unlockedResearch.has("trainingMethods") ? 1.3 : 1);
      for(const student of students){
        const fatigueMod = student.energy<30 ? 0.4 : 1;
        const prevRank = student.rank;
        student.skillPoints = clamp(student.skillPoints + perStudentRate*fatigueMod*dt, 1, 1000);
        student.rank = rankForSkill(student.skillPoints);
        if(student.rank !== prevRank){
          this.pushToast(student.name+" has been promoted to "+STAFF_RANKS[student.rank].label+"!", "good");
        }
      }
      trainer.energy = clamp(trainer.energy - dt*0.15, 0, 100);
      students.forEach(s=> s.energy = clamp(s.energy - dt*0.1, 0, 100));
    }
  }
  _updateResearch(dt){
    const speedMult = this.unlockedResearch.has("seniorResearchers") ? 1.4 : 1;
    let rate = 0;
    for(const s of this.staff){
      if(s.type==="researcher" && s.state==="idle" && s.atSlot){
        const room = this.hospital.rooms.find(r=>r.id===s.assignedRoomId);
        if(room && room.type==="research"){
          rate += (0.6 + s.skill/100) * speedMult;
        }
      }
    }
    if(rate>0) this.economy.researchPoints += rate*dt;
  }

  _onNewDay(){
    let salaries=0;
    this.staff.forEach(s=> salaries += s.salary);
    this.economy.spend(salaries);
    // daily utility/energy cost for every built room, on top of staff salaries
    let energyBill=0;
    this.hospital.rooms.forEach(r=> energyBill += ROOM_TYPES[r.type].energyCost||0);
    if(energyBill>0) this.economy.spend(energyBill);
    // rooms wear down a little every day - the janitor (maintenance staff) repairs them back up
    this.hospital.rooms.forEach(r=>{
      const rate = ROOM_TYPES[r.type].decayRate||0;
      r.condition = clamp((r.condition==null?100:r.condition) - rate, 0, 100);
    });
    this._chargeLoanPayment();
    // record the day that's ending before resetting the daily counters, so the Manage tab
    // can chart income vs expense history
    this.economy.history.push({ day:this.day, income:this.economy.dailyIncome, expense:this.economy.dailyExpense });
    if(this.economy.history.length>60) this.economy.history.shift();
    this.day++;
    this.economy.resetDaily();
    if(this.economy.money < 0){
      this.pushToast("⚠ Negative cash flow! Cut your expenses.", "bad");
    }
    // Random daily events also get more frequent as the days pass (same difficulty curve as
    // emergencies), instead of a flat 35% chance forever.
    if(Math.random() < lerp(0.28, 0.5, this._difficultyProgress())){ this._triggerRandomEvent(); }
    this.save();
  }

  _triggerRandomEvent(){
    const total = EVENT_TYPES.reduce((a,e)=>a+e.weight,0);
    let r = Math.random()*total;
    let ev = EVENT_TYPES[0];
    for(const e of EVENT_TYPES){ if(r<e.weight){ ev=e; break;} r-=e.weight; }
    if(ev.id==="bonus"){
      const amt = 300+Math.floor(Math.random()*700);
      this.economy.earn(amt);
      this.pushToast("💰 "+ev.text+" (+"+amt+" $)", "good");
    } else if(ev.id==="influx"){
      this.spawnTimer = 0.5;
      this.pushToast("👥 "+ev.text, "bad");
    } else if(ev.id==="inspector"){
      // Design feedback: an inspector arriving is exactly the kind of thing a player needs to
      // know about right away, not several messages later.
      this.pushToast("🕵️ "+ev.text, "bad", true);
    } else {
      this.pushToast(ev.text, "bad");
    }
  }

  _spawnLogic(dt){
    if(!this.hasStartedPlaying) return; // nobody arrives until the player presses Play
    this.spawnTimer -= dt;
    if(this.spawnTimer<=0){
      const recRooms = this.hospital.roomsOfType("reception");
      // Fewer patients allowed in early on (design feedback: the flow should start light) -
      // grows gradually as the days pass. Ceiling raised and the ramp stretched out further
      // (design feedback: difficulty should keep evolving over time rather than plateauing
      // early) - now keeps climbing until day ~48 instead of leveling off by day ~18.
      const capacityLimit = Math.round(clamp(6 + this.day*0.5, 6, 30));
      if(recRooms.length>0 && this.patients.length<capacityLimit){
        const diseaseKey = this._pickDiseaseKey();
        const p = new Patient(this.hospital, diseaseKey);
        this.patients.push(p);
      }
      // Spawn interval itself also ramps down gradually - stretched to match the same ~40-day
      // difficulty curve as emergencies/events (_difficultyProgress) instead of finishing by
      // day 14 and then never getting busier again.
      const rampProgress = this._difficultyProgress();
      const minGap = lerp(16, 5, rampProgress), maxGap = lerp(26, 11, rampProgress);
      this.spawnTimer = minGap + Math.random()*(maxGap-minGap);
    }
  }

  // Progressive difficulty (design doc-style pacing): early on, only the diseases a starter
  // hospital can plausibly treat show up. Tougher cases needing more rooms/skill are phased in
  // over the first couple of weeks, so the player is never handed an untreatable patient on day 1.
  _availableDiseaseKeys(){
    const maxSeverity = this.day<=3 ? 0.22 : this.day<=7 ? 0.32 : this.day<=14 ? 0.4 : 1.0;
    const keys = DISEASE_KEYS.filter(k=>DISEASES[k].severity<=maxSeverity);
    return keys.length? keys : DISEASE_KEYS;
  }

  // Which diseases can show up is only half the difficulty curve - the other half is how OFTEN.
  // A uniform pick lets a hospital coast forever on only the cheapest, pharmacy-only cases once
  // the harder ones are merely "possible". This weights the pick toward higher-severity diseases
  // as the days pass, so a hospital that never expands past Reception/Consultation/Pharmacy
  // faces a shrinking share of patients it can actually treat - real pressure to build the
  // Treatment/Operating/Diagnostic rooms the alerts are already asking for.
  _pickDiseaseKey(){
    const keys = this._availableDiseaseKeys();
    const pressure = clamp(this.day/25, 0, 1.4); // keeps climbing slowly past day 25 too
    const weights = keys.map(k => 1 + DISEASES[k].severity*pressure*3.5);
    const total = weights.reduce((a,b)=>a+b,0);
    let r = Math.random()*total;
    for(let i=0;i<keys.length;i++){ r -= weights[i]; if(r<=0) return keys[i]; }
    return keys[keys.length-1];
  }

  _findAvailableRoomWithStaff(type){
    const rooms = this.hospital.roomsOfType(type);
    // prefer room with idle assigned staff and shortest queue
    let best=null, bestScore=Infinity;
    for(const r of rooms){
      if(r._constructing || r._demolishing) continue; // not usable yet / not usable anymore
      if(r.machineBroken) continue; // skip broken equipment - try another room of this type instead
      const hasStaff = r.staffIds.some(id=>this.staff.find(s=>s.id===id));
      if(!hasStaff && ROOM_TYPES[type].needsDoctor) continue;
      const score = r.queue.length;
      if(score<bestScore){ bestScore=score; best=r; }
    }
    return best;
  }

  // All room types that provide diagnosis power (category:"diagnostic"), excluding the GP's
  // Office itself - i.e. every "specialist station" a patient can be sent to for extra tests:
  // Diagnostic Room, Cardiogram, Scanner, Ultrascan, Blood Machine, X-Ray, Ward.
  _diagnosticRoomTypes(){
    if(!this._diagRoomTypesCache){
      this._diagRoomTypesCache = Object.keys(ROOM_TYPES).filter(k=>ROOM_TYPES[k].category==="diagnostic" && k!=="consultation");
    }
    return this._diagRoomTypesCache;
  }

  // Design doc §7's progressive diagnosis loop: GP -> specialist station -> GP -> specialist
  // station... generalized so the "specialist station" side rotates through every diagnostic
  // room type the hospital actually has built and staffed, instead of always being the single
  // literal "Diagnostic Room". Prefers higher-diagnosisPower equipment, and prefers a station
  // this patient hasn't already visited (more new information) before repeating one.
  _pickNextDiagnosticRoomType(p, currentType){
    if(currentType!=="consultation"){
      return "consultation"; // always alternate back to the GP between specialist stations
    }
    const visited = p._diagVisited || (p._diagVisited = new Set());
    const candidates = this._diagnosticRoomTypes()
      .map(t => ({t, room:this._findAvailableRoomWithStaff(t)}))
      .filter(x=>x.room)
      .sort((a,b)=>{
        const av = visited.has(a.t)?1:0, bv = visited.has(b.t)?1:0;
        if(av!==bv) return av-bv; // unvisited stations first
        return (ROOM_TYPES[b.t].diagnosisPower||0) - (ROOM_TYPES[a.t].diagnosisPower||0);
      });
    if(candidates.length){
      visited.add(candidates[0].t);
      return candidates[0].t;
    }
    // nothing built/staffed to try - repeat the GP if that's still available, otherwise there's
    // genuinely no diagnosis capacity left and the caller falls back to a best-guess treatment
    return this._findAvailableRoomWithStaff("consultation") ? "consultation" : null;
  }

  _updatePatients(dt){
    for(const p of this.patients){
      p.animT += dt; // was never incremented before - patients stood with frozen legs/arms
      p.stateTimer -= dt;
      // History log (design feedback: "I should be able to see a history of status changes for
      // a patient/staff in their details"): whenever their state actually changes this frame,
      // record it with a human-readable label and a timestamp. Capped so it can't grow forever.
      if(p.state !== p._lastLoggedState){
        p._history = p._history || [];
        p._history.push({ t:this.simTime, label:this._patientStateLabel(p.state) });
        if(p._history.length>60) p._history.shift();
        p._lastLoggedState = p.state;
      }

      // health-vs-time (design doc §2): a patient keeps losing health from their disease the
      // whole time they're unwell - queues, corridors, incomplete diagnosis, all of it - not
      // just from standing in line. This is on top of the separate standing/energy penalty.
      if(p.state!=="leaving" && p.state!=="gone" && p.state!=="dead" && p.health>0){
        p.health = clamp(p.health - p.disease.healthDecayRate*dt, 0, 100);
        if(p.health<=0){ this._patientDies(p); continue; }
      }
      if(p.state==="dead"){
        // The body stays put and visible until a janitor actually cleans it up (see
        // _patientDies / the "cleaning" staff state, which is what now sets state="gone") -
        // deadTimer still counts up for the fall-down/settle fade-in animation, just doesn't
        // drive removal anymore.
        p.deadTimer = (p.deadTimer||0) + dt;
        continue;
      }

      // thirst (design doc §10, scoped to just thirst for now): rises the whole time they're
      // in the hospital; past a threshold they try to slip off to a fountain; if it maxes out
      // unresolved, it starts costing health on top of everything else
      if(p.state!=="leaving" && p.state!=="gone" && p.state!=="errand"){
        p.thirst = clamp(p.thirst + 0.5*dt, 0, 100);
        if(p.thirst>=100){
          p.health = clamp(p.health - dt*1.5, 0, 100);
          if(p.health<=0){ this._patientDies(p); continue; }
        }
        this._maybeDispatchThirstErrand(p);
      }

      // gastric ejections / the squits: if left waiting too long while genuinely unhappy about
      // it, they leave a mess right where they're standing - visible, costs reputation, and
      // sits there until a janitor cleans it up
      if((p.diseaseKey==="gastricEjections" || p.diseaseKey==="theSquits") && p.state && p.state.startsWith("queue") && p.happiness<40){
        p._messCooldown = (p._messCooldown||0) - dt;
        if(p._messCooldown<=0){
          if(Math.random() < 0.12) this._createMess(p);
          p._messCooldown = 15 + Math.random()*10;
        }
      }

      switch(p.state){
        case "arriving": {
          const rec = this._findAvailableRoomWithStaff("reception") || this.hospital.roomsOfType("reception")[0];
          if(rec){
            p.targetRoomId = rec.id;
            const door = this.hospital.doorWorld(rec);
            const tx=Math.floor(door.x/TILE), ty=Math.floor(door.y/TILE);
            p.setPathToTile(this.hospital, tx, ty);
            p.state="toReception";
          }
          break;
        }
        case "toReception": {
          const result = this._advancePatientToRoom(p, dt);
          if(result==="arrived"){
            const rec = this.hospital.rooms.find(r=>r.id===p.targetRoomId);
            if(rec){
              rec.queue.push(p.id);
              p.queueKind = "queueReception";
              this._tryUseWaitingRoom(p, rec);
            }
          } else if(result==="stuck"){
            p.state="leaving"; this._sendToExit(p);
          }
          break;
        }
        case "toWaitingRoom": {
          const wr = this.hospital.rooms.find(r=>r.id===p.waitingRoomId);
          if(!wr){ p.state = p.queueKind; break; }
          if(p.wrPhase==="toDoor"){
            if(!p.path){ p.setPathToTile(this.hospital, wr.door.x, wr.door.y); }
            if(this._giveUpIfStuck(p)){ this._leaveWaitingRoom(p); p.state = p.queueKind; break; }
            const done = p.updateMovement(dt);
            if(done){ p.wrPhase = "toSeat"; }
          } else if(p.wrPhase==="toSeat"){
            const seat = this.hospital.waitingSeatWorld(wr, p.seatIndex);
            if(p.moveToward(seat.x, seat.y, dt, p.speed)){
              p.seated = true;
              p.wrPhase = null;
              p.state = p.queueKind;
            }
          }
          this._applyWaitEffects(p, dt, false); // still walking in, counts as standing
          break;
        }
        case "toChair": {
          const chair = this.hospital.objects.find(o=>o.id===p.chairObjId);
          if(!chair){ p.chairObjId=null; p.state = p.queueKind; break; }
          if(!p.path){ p.setPathToTile(this.hospital, chair.x, chair.y); }
          if(this._giveUpIfStuck(p)){ this._leaveWaitingRoom(p); p.state = p.queueKind; break; }
          const done = p.updateMovement(dt);
          if(done){ p.seated = true; p.state = p.queueKind; }
          this._applyWaitEffects(p, dt, false); // still walking there, counts as standing
          break;
        }
        case "errand": {
          // a quick, self-contained detour (currently just thirst/fountain) - walks there,
          // pauses briefly, resolves the need, then resumes exactly where they left off.
          // Retries the path each frame while it's null, both to self-heal from a temporary
          // block and so _giveUpIfStuck's fail-streak counter actually has a chance to trip.
          if(!p.path && p.errandTargetTile){
            p.setPathToTile(this.hospital, p.errandTargetTile.x, p.errandTargetTile.y);
          }
          if(this._giveUpIfStuck(p)){ this._returnFromErrand(p, true); break; }
          const done = p.updateMovement(dt);
          if(done){
            if(p.errandTimer>0){ p.errandTimer -= dt; break; }
            this._returnFromErrand(p, false);
          }
          break;
        }
        case "beingRecalled": {
          const room = this.hospital.rooms.find(r=>r.id===p.recallRoomId);
          if(!room){ p.state="leaving"; this._sendToExit(p); break; }
          if(!p.path){ p.setPathToTile(this.hospital, room.door.x, room.door.y); }
          const done = p.updateMovement(dt);
          if(done){
            this._leaveWaitingRoom(p);
            if(p.recallKind==="reception"){
              room.queue = room.queue.filter(id=>id!==p.id);
              const con = this._findAvailableRoomWithStaff("consultation") || this.hospital.roomsOfType("consultation")[0];
              if(con){
                p.targetRoomId = con.id;
                const door = this.hospital.doorWorld(con);
                p.setPathToTile(this.hospital, Math.floor(door.x/TILE), Math.floor(door.y/TILE));
                p.state="toConsult";
              } else {
                room.queue.unshift(p.id);
                p.state = "queueReception";
              }
            } else {
              const worker = this._getFreeWorker(room);
              if(worker){
                room.queue = room.queue.filter(id=>id!==p.id);
                worker.state="working"; worker.currentPatientId=p.id;
                worker.workPhase="toDoor"; worker.path=null; worker.atSlot=false; worker.pendingGreetId=p.id;
                p.arrivedAtSlot=false;
                p.stateTimer=9999;
                p.state = p.recallKind==="consult" ? "beingConsulted" : "beingTreated";
              } else {
                // the worker was taken in the meantime - rejoin the front of the line and retry shortly
                room.queue.unshift(p.id);
                p.state = p.queueKind;
              }
            }
          }
          this._applyWaitEffects(p, dt, false);
          break;
        }
        case "queueReception": {
          const rec = this.hospital.rooms.find(r=>r.id===p.targetRoomId);
          if(rec){
            if(!p.seated) this._updateQueueMotion(p, rec, dt);
            if(this._isServable(rec,p)){
              if(p.seated){
                this._recallFromWaitingRoom(p, rec, "reception");
              } else {
                // registration takes a little real time - more so for a more serious case
                // (more history/paperwork to take down), instead of an instant pass-through
                if(p.regTimer==null) p.regTimer = 3 + p.disease.severity*10;
                p.regTimer -= dt;
                if(p.regTimer <= 0){
                  p.regTimer = null;
                  rec.queue = rec.queue.filter(id=>id!==p.id);
                  const con = this._findAvailableRoomWithStaff("consultation") || this.hospital.roomsOfType("consultation")[0];
                  if(con){
                    p.targetRoomId = con.id;
                    const door = this.hospital.doorWorld(con);
                    p.setPathToTile(this.hospital, Math.floor(door.x/TILE), Math.floor(door.y/TILE));
                    p.state="toConsult";
                  } else {
                    p.happiness -= dt*2;
                  }
                }
              }
            }
          }
          this._applyWaitEffects(p, dt, p.seated, rec);
          break;
        }
        case "toConsult": {
          const result = this._advancePatientToRoom(p, dt);
          if(result==="arrived"){
            const con = this.hospital.rooms.find(r=>r.id===p.targetRoomId);
            if(con){
              con.queue.push(p.id);
              p.queueKind = "queueConsult";
              this._tryUseWaitingRoom(p, con);
            }
          } else if(result==="stuck"){
            p.state="leaving"; this._sendToExit(p);
          }
          break;
        }
        case "queueConsult": {
          const con = this.hospital.rooms.find(r=>r.id===p.targetRoomId);
          if(con){
            if(!p.seated) this._updateQueueMotion(p, con, dt);
            if(this._isServable(con,p)){
              if(p.seated){
                this._recallFromWaitingRoom(p, con, "consult");
              } else {
                const doc = this._getFreeWorker(con);
                if(doc){
                  con.queue = con.queue.filter(id=>id!==p.id);
                  doc.state="working"; doc.currentPatientId=p.id;
                  doc.workPhase="toDoor"; doc.path=null; doc.atSlot=false; doc.pendingGreetId=p.id;
                  p.state="beingConsulted";
                  p.arrivedAtSlot=false;
                  p.stateTimer = 9999;
                }
              }
            }
          }
          this._applyWaitEffects(p, dt, p.seated, con);
          break;
        }
        case "beingConsulted": {
          const con = this.hospital.rooms.find(r=>r.id===p.targetRoomId);
          if(!con){ p.state="leaving"; this._sendToExit(p); break; }
          if(!p.arrivedAtSlot){
            const doc0 = this.staff.find(s=>s.currentPatientId===p.id);
            // wait at the door - don't walk in - until the doctor has actually arrived to
            // greet them (workPhase past "toDoor")
            if(doc0 && doc0.workPhase==="toDoor") break;
            const slot = this.hospital.patientSlotWorld(con, doc0? doc0.slotIndex:0);
            if(p.moveToward(slot.x, slot.y, dt, p.speed)){
              p.arrivedAtSlot = true;
              const doc = this.staff.find(s=>s.currentPatientId===p.id);
              p.stateTimer = p.disease.diagTime / (0.5 + (doc? doc.skill:40)/100);
            }
            break;
          }
          if(p.stateTimer<=0){
            const doc = this.staff.find(s=>s.currentPatientId===p.id);
            // a run-down room gives worse readings - a neglected machine, faded charts, etc.
            const conditionMod = 0.55 + clamp(con.condition??100,0,100)/100*0.45;
            const power = (ROOM_TYPES[con.type].diagnosisPower || 12) * conditionMod;
            // an exhausted doctor (see the Send Staff to Rest policy) makes mistakes
            const fatiguePenalty = doc && doc.energy<15 ? 0.75 : 1;
            const skillMod = (0.5 + (doc? doc.skill:40)/100) * fatiguePenalty;
            p.diagnosisProgress = clamp(p.diagnosisProgress + power*skillMod, 0, 100);
            const justDiagnosed = !p.diagnosed && p.diagnosisProgress >= p.disease.diagnosisRequired;
            p.diagnosed = p.diagnosisProgress >= p.disease.diagnosisRequired;
            con.patientsServed++;
            con.lastServedAt = this.simTime;
            this._wearMachine(con);
            this._logHistory(p, justDiagnosed
              ? "🔍 Diagnosed at "+ROOM_TYPES[con.type].name+" ("+Math.round(p.diagnosisProgress)+"%)"
              : "🔍 Examined at "+ROOM_TYPES[con.type].name+" - "+Math.round(p.diagnosisProgress)+"% diagnosed, needs more tests");
            if(doc){ doc.workPhase="seeingOut"; doc.path=null; doc.currentPatientId=null; }
            p.exitRoomId = con.id;

            if(p.diagnosed){
              p.diagnosisConfidence = 1;
              // Diagnosis Termination policy (Theme Hospital's policy screen): above 100%, the
              // hospital keeps a fully-diagnosed patient for extra paid "tests" they don't
              // actually need, purely for the money. Each round risks the patient's patience -
              // if they get fed up, they walk out without ever paying for the eventual cure.
              const extraRoundsWanted = Math.round((this.policy.diagnosisTermination-100)/25);
              p.milkedCount = p.milkedCount||0;
              const nextType = this._pickNextDiagnosticRoomType(p, con.type);
              const nextRoom = nextType && this._findAvailableRoomWithStaff(nextType);
              if(extraRoundsWanted>0 && p.milkedCount<extraRoundsWanted && nextRoom && p.happiness>15){
                p.milkedCount++;
                const fee = Math.round(p.disease.reward*0.12);
                this.economy.earn(fee);
                this._spawnFloatingText(p.x, p.y, "+$"+fee, "#4caf50", "money");
                p.happiness -= 10;
                p.exitAfter = {type:"toRoom", roomType:nextType, nextState:"toConsult"};
              } else if(extraRoundsWanted>0 && p.milkedCount>0 && p.happiness<=15){
                // fed up with the unnecessary extra testing - leaves without paying at all
                this.hospitalReputation = clamp(this.hospitalReputation-3, 0, 100);
                this.pushToast(p.name+" left without paying - kept waiting too long for tests.", "bad");
                p.exitAfter = {type:"leave"};
              } else if(this._maybeAskAboutMissingRoom(p)){
                // A brand-new condition whose treatment room doesn't exist yet - the player
                // needs to be asked what to do with this patient (see the choice modal); freeze
                // them here instead of routing toward a room that isn't there.
                p.state = "awaitingDecision";
                break;
              } else {
                p.exitAfter = {type:"toRoom", roomType:p.disease.room, nextState:"toTreatment"};
              }
            } else {
              p.diagnosisAttempts++;
              // Rotate through every built, staffed diagnostic-category room (GP, Cardiogram,
              // Scanner, Ultrascan, Blood Machine, X-Ray, Ward - design doc §7's alternating
              // GP<->specialist-station loop, generalized from the old GP<->"Diagnostic Room" pair
              // now that there are several flavors of diagnostic equipment).
              const nextType = this._pickNextDiagnosticRoomType(p, con.type);
              const nextRoom = nextType && this._findAvailableRoomWithStaff(nextType);
              const maxAttempts = Math.min(6, 1+this._diagnosticRoomTypes().length);
              if(p.diagnosisAttempts < maxAttempts && nextRoom){
                p.happiness -= 6;
                p.exitAfter = {type:"toRoom", roomType:nextType, nextState:"toConsult"};
              } else if(this._maybeAskAboutExhaustedDiagnosis(p)){
                // Out of diagnostic capacity/attempts - ask the player what to do instead of
                // silently defaulting to "proceed on a guess".
                p.state = "awaitingDecision";
                break;
              } else {
                // no more diagnosis capacity or attempts left - proceed on a best guess
                // (design doc §8): treatment still happens, just with reduced confidence
                p.diagnosisConfidence = clamp(p.diagnosisProgress / p.disease.diagnosisRequired, 0.35, 0.95);
                p.happiness -= 8;
                p.exitAfter = {type:"toRoom", roomType:p.disease.room, nextState:"toTreatment"};
              }
            }
            p.state="walkOut";
          }
          break;
        }
        case "awaitingDecision": {
          // Frozen in place until the player answers the choice modal (see
          // _maybeAskAboutMissingRoom / _maybeAskAboutExhaustedDiagnosis) - the modal itself
          // pauses the sim, so in practice this state is only ever "held" for the rest of the
          // current tick; the callback moves them on to whatever was actually chosen.
          break;
        }
        case "waitingForRoom": {
          // Patiently waiting, at the player's request, either for their treatment room to get
          // built (_waitingReason "treatment") or for more diagnostic capacity
          // (_waitingReason "diagnosis") - periodically rechecks and resumes their visit the
          // moment what they're waiting for actually shows up.
          if(p._waitingReason==="diagnosis"){
            const nextType = this._pickNextDiagnosticRoomType(p, null);
            const nextRoom = nextType && this._findAvailableRoomWithStaff(nextType);
            if(nextRoom){
              p.happiness = clamp(p.happiness+5, 0, 100); // relief that progress is finally possible again
              p.exitAfter = {type:"toRoom", roomType:nextType, nextState:"toConsult"};
              p.state = "walkOut";
              this._logHistory(p, "🔍 New diagnostic capacity available - resuming diagnosis");
            }
          } else {
            const target = this._findAvailableRoomWithStaff(p.disease.room);
            if(target){
              p.targetRoomId = target.id;
              const door = this.hospital.doorWorld(target);
              p.setPathToTile(this.hospital, Math.floor(door.x/TILE), Math.floor(door.y/TILE));
              p.state = "toTreatment";
              this._logHistory(p, "🏗 Their room is ready - heading to treatment");
            }
          }
          break;
        }
        case "toTreatment": {
          const result = this._advancePatientToRoom(p, dt);
          if(result==="arrived"){
            const t = this.hospital.rooms.find(r=>r.id===p.targetRoomId);
            if(t){
              t.queue.push(p.id);
              p.queueKind = "queueTreatment";
              this._tryUseWaitingRoom(p, t);
            }
          } else if(result==="stuck"){
            p.state="leaving"; this._sendToExit(p);
          }
          break;
        }
        case "queueTreatment": {
          const t = this.hospital.rooms.find(r=>r.id===p.targetRoomId);
          if(t){
            if(!p.seated) this._updateQueueMotion(p, t, dt);
            if(this._isServable(t,p)){
              if(p.seated){
                this._recallFromWaitingRoom(p, t, "treat");
              } else {
                const surgeonsNeeded = ROOM_TYPES[t.type].surgeonsRequired || 1;
                if(surgeonsNeeded > 1){
                  // Operating Theatre: grab the whole team at once. The highest-skill member
                  // leads (full door-greet/see-out escort, same as any other room); the rest
                  // are marked busy on this same patient so they can't get pulled elsewhere
                  // mid-procedure, but just hold their slot rather than walking a separate escort.
                  const team = this._getFreeWorkers(t, surgeonsNeeded);
                  if(team){
                    const [lead, ...assistants] = team;
                    t.queue = t.queue.filter(id=>id!==p.id);
                    lead.state="working"; lead.currentPatientId=p.id;
                    lead.workPhase="toDoor"; lead.path=null; lead.atSlot=false; lead.pendingGreetId=p.id;
                    // NOTE: assistants deliberately do NOT get currentPatientId set - that field
                    // is how the rest of the state machine (beingTreated's workPhase=="toDoor"
                    // greet-gate, the escort choreography) finds "the" treating worker via
                    // staff.find(s=>s.currentPatientId===p.id), and having two matches would make
                    // that resolve unpredictably. state:"working" alone is enough to keep them out
                    // of _getFreeWorker/_freeWorkerCount until explicitly released below.
                    assistants.forEach(a=>{ a.state="working"; a.workPhase="atSlot"; a.atSlot=true; });
                    p.assistingStaffIds = assistants.map(a=>a.id);
                    p.state="beingTreated";
                    p.arrivedAtSlot=false;
                    p.stateTimer = 9999;
                  }
                } else {
                  const worker = this._getFreeWorker(t);
                  if(worker){
                    t.queue = t.queue.filter(id=>id!==p.id);
                    worker.state="working"; worker.currentPatientId=p.id;
                    worker.workPhase="toDoor"; worker.path=null; worker.atSlot=false; worker.pendingGreetId=p.id;
                    p.state="beingTreated";
                    p.arrivedAtSlot=false;
                    p.stateTimer = 9999;
                  }
                }
              }
            }
          }
          this._applyWaitEffects(p, dt, p.seated, t);
          break;
        }
        case "beingTreated": {
          const t = this.hospital.rooms.find(r=>r.id===p.targetRoomId);
          if(!t){
            this._releaseTreatmentTeam(p);
            p.state="leaving"; this._sendToExit(p); break;
          }
          if(!p.arrivedAtSlot){
            const worker0 = this.staff.find(s=>s.currentPatientId===p.id);
            if(worker0 && worker0.workPhase==="toDoor") break; // wait to be greeted, same as consultation
            const slot = this.hospital.patientSlotWorld(t, worker0? worker0.slotIndex:0);
            if(p.moveToward(slot.x, slot.y, dt, p.speed)){
              p.arrivedAtSlot = true;
              const worker = this.staff.find(s=>s.currentPatientId===p.id);
              // Operating Theatre: the whole team's average skill drives pacing/quality, not
              // just the lead's - a strong assistant (or a Surgeon specialty) genuinely helps.
              const assistants = (p.assistingStaffIds||[]).map(id=>this.staff.find(s=>s.id===id)).filter(Boolean);
              p._teamSkill = assistants.length
                ? (worker.skill + assistants.reduce((sum,a)=>sum+a.skill,0)) / (1+assistants.length)
                : (worker? worker.skill : 40);
              p.stateTimer = p.disease.treatTime / (0.5+p._teamSkill/100);
            }
            break;
          }
          if(p.stateTimer<=0){
            const worker = this.staff.find(s=>s.currentPatientId===p.id);
            if(worker){ worker.workPhase="seeingOut"; worker.path=null; worker.currentPatientId=null; worker.energy=clamp(worker.energy-8,0,100); }
            // Assistants don't do the escort walk - just get freed up and pay their own,
            // smaller energy cost for having scrubbed in.
            (p.assistingStaffIds||[]).forEach(id=>{
              const a = this.staff.find(s=>s.id===id);
              if(a){ a.state="idle"; a.workPhase=null; a.currentPatientId=null; a.atSlot=true; a.energy=clamp(a.energy-5,0,100); }
            });
            p.assistingStaffIds = [];
            t.patientsServed++;
            t.lastServedAt = this.simTime;
            this._wearMachine(t);
            const advancedBonus = this.unlockedResearch.has("advancedTreatment") ? 0.08 : 0;
            // a treatment based on a "best guess" (diagnosisConfidence < 1, see design doc §8)
            // is meaningfully less reliable than one backed by a full diagnosis
            const confidencePenalty = (1 - p.diagnosisConfidence) * 0.4;
            // worn-down equipment (see the janitor/condition system) hurts outcomes too
            const conditionPenalty = (1 - clamp(t.condition??100,0,100)/100) * 0.3;
            // an exhausted worker (Send Staff to Rest policy pushed too far) makes mistakes
            const fatiguePenalty = worker && worker.energy<15 ? 0.15 : 0;
            const teamSkill = p._teamSkill!=null ? p._teamSkill : (worker? worker.skill : 40);
            // Surgeon specialty (design doc §3.2) gives a real edge in the Operating Theatre,
            // on top of raw skill.
            const specialtyBonus = (ROOM_TYPES[t.type].surgeonsRequired>1 && worker && worker.specialty==="surgeon") ? 0.06 : 0;
            const surgicalProgramsBonus = (ROOM_TYPES[t.type].surgeonsRequired>1 && this.unlockedResearch.has("surgicalPrograms")) ? 0.06 : 0;
            const successChance = 0.65 + advancedBonus + specialtyBonus + surgicalProgramsBonus + (teamSkill/300) - p.disease.severity*0.2 - confidencePenalty - conditionPenalty - fatiguePenalty;
            const success = Math.random() < clamp(successChance,0.05,0.97);
            p._teamSkill = null;
            if(success){
              this.economy.earn(p.disease.reward);
              this.economy.totalTreated++;
              p.health = 100; p.happiness = clamp(p.happiness+10,0,100);
              // Rebalanced (design feedback: reputation was drifting to 0 even in a healthy
              // hospital): a typical ~70-85% success rate needs the per-cure reward to clearly
              // outweigh the occasional failure below, or reputation trends down even when
              // most patients are being cured successfully. +2.2 per cure vs -2.5 per failure
              // means a hospital succeeding more than ~53% of the time trends upward overall.
              this.hospitalReputation = clamp(this.hospitalReputation+2.2, 0, 100);
              this._spawnFloatingText(p.x, p.y, "+$"+p.disease.reward, "#4caf50", "money");
              this._logHistory(p, "✅ Treated successfully at "+ROOM_TYPES[t.type].name+" (+$"+p.disease.reward+")");
              if(p.isEmergency && this.activeEmergency && this.activeEmergency.patientIds.includes(p.id)){
                this.activeEmergency.curedCount++;
                p.isEmergency = false;
              }
              // no toast here on purpose - a routine cure isn't worth interrupting the player
              // for; the floating "+$" over the patient is feedback enough. Toasts are reserved
              // for failures and things that actually need attention.
            } else {
              this.economy.totalFailed++;
              p.health -= 20; p.happiness -=20;
              // a failed treatment used to be a pure non-event for the hospital's standing -
              // now it actually costs reputation, but toned down from the original -4 (paired
              // with the +2.2 cure reward above, this is what keeps a reasonably-run hospital's
              // reputation trending upward instead of slowly bleeding to 0 regardless of play).
              this.hospitalReputation = clamp(this.hospitalReputation - 2.5, 0, 100);
              this.pushToast(p.name+" treatment failed...", "bad");
              this._logHistory(p, "❌ Treatment failed at "+ROOM_TYPES[t.type].name);
            }
            p.exitRoomId = t.id;
            p.exitAfter = {type:"leave"};
            p.state="walkOut";
          }
          break;
        }
        case "walkOut": {
          const room = this.hospital.rooms.find(r=>r.id===p.exitRoomId);
          const doorInside = room? this.hospital.doorInsideWorld(room) : {x:p.x,y:p.y};
          const done = p.moveToward(doorInside.x, doorInside.y, dt, p.speed);
          if(done){
            const after = p.exitAfter;
            p.exitAfter = null;
            if(!after || after.type==="leave"){
              p.state="leaving"; this._sendToExit(p);
            } else if(after.type==="toRoom"){
              const target = this._findAvailableRoomWithStaff(after.roomType) || this.hospital.roomsOfType(after.roomType)[0];
              if(target){
                p.targetRoomId = target.id;
                const door = this.hospital.doorWorld(target);
                p.setPathToTile(this.hospital, Math.floor(door.x/TILE), Math.floor(door.y/TILE));
                p.state = after.nextState || "toTreatment";
              } else {
                p.happiness -= 15;
                // ignoring the "you need this room" alert has a real, if modest, cost now -
                // previously a patient could be turned away indefinitely with zero consequence.
                // Also now explicit about WHY (design feedback: "patients seem to get treated
                // but never pay" - they weren't actually being treated at all, there was just no
                // built+staffed room of the type their disease needed, and they silently gave up
                // with no visible explanation).
                this.hospitalReputation = clamp(this.hospitalReputation - 1, 0, 100);
                this.pushToast(p.name+" left unpaid - no working "+(ROOM_TYPES[after.roomType]?ROOM_TYPES[after.roomType].name:after.roomType)+" for their condition.", "bad", true);
                this._logHistory(p, "⚠ Left unpaid - no working "+(ROOM_TYPES[after.roomType]?ROOM_TYPES[after.roomType].name:after.roomType)+" available");
                p.state="leaving"; this._sendToExit(p);
              }
            }
          }
          break;
        }
        case "leaving": {
          // Same robustness as the other movement legs: if the path to the entrance ever fails
          // and never recovers, the patient must not become a permanent ghost stuck mid-map -
          // after enough failed attempts, just let them go (they're already leaving anyway).
          if(!p.path){ this._sendToExit(p); }
          if(this._giveUpIfStuck(p)){ p.state="gone"; break; }
          const done = p.updateMovement(dt);
          if(done){ p.state="gone"; }
          break;
        }
        default: break;
      }
      if(p.happiness<=0 && p.state!=="leaving" && p.state!=="gone" && p.state!=="walkOut"){
        this._leaveWaitingRoom(p);
        if(p.targetRoomId){
          const r = this.hospital.rooms.find(x=>x.id===p.targetRoomId);
          if(r) r.queue = r.queue.filter(id=>id!==p.id);
        }
        p.state="leaving"; this._sendToExit(p);
      }
    }
    this.patients = this.patients.filter(p=>p.state!=="gone");
  }

  // Looks for a seat before letting a patient stand in line: a nearby Chair (cheap, close,
  // player-placed) is tried first, then a full Waiting Room, then standing as the last resort.
  _tryUseWaitingRoom(p, serviceRoom){
    const chair = this.hospital.findNearbyChair(serviceRoom);
    if(chair){
      chair.occupiedBy = p.id;
      p.chairObjId = chair.id;
      p.seated = false;
      p.path = null;
      p.state = "toChair";
      return;
    }
    const wr = this.hospital.findNearbyWaitingRoom(serviceRoom);
    if(wr){
      // find the lowest free seat index rather than just appending - patients cycle in and out,
      // so array length alone would eventually hand out a duplicate index
      const usedIndices = new Set(
        this.patients.filter(o=>o.waitingRoomId===wr.id && o.id!==p.id).map(o=>o.seatIndex)
      );
      let seatIdx = 0;
      while(usedIndices.has(seatIdx) && seatIdx < wr.seatCapacity) seatIdx++;
      wr.seatedIds.push(p.id);
      p.waitingRoomId = wr.id;
      p.seatIndex = seatIdx;
      p.seated = false;
      p.wrPhase = "toDoor";
      p.path = null;
      p.state = "toWaitingRoom";
    } else {
      p.seated = false;
      p.state = p.queueKind;
    }
  }

  _recallFromWaitingRoom(p, room, kind){
    if(p.state==="beingRecalled") return;
    p.recallRoomId = room.id;
    p.recallKind = kind;
    p.path = null;
    p.state = "beingRecalled";
  }

  _leaveWaitingRoom(p){
    if(p.waitingRoomId){
      const wr = this.hospital.rooms.find(r=>r.id===p.waitingRoomId);
      if(wr && wr.seatedIds) wr.seatedIds = wr.seatedIds.filter(id=>id!==p.id);
    }
    if(p.chairObjId){
      const chair = this.hospital.objects.find(o=>o.id===p.chairObjId);
      if(chair && chair.occupiedBy===p.id) chair.occupiedBy = null;
    }
    p.waitingRoomId=null; p.seatIndex=-1; p.seated=false; p.chairObjId=null;
  }

  // Safety net for the null-path fix above: if a target has been genuinely unreachable for
  // ~3 real seconds straight (e.g. a chair the player later walled in), stop retrying forever -
  // give up gracefully instead of soft-locking the patient in place.
  _giveUpIfStuck(entity){
    return (entity._pathFailStreak||0) > 180;
  }

  // Generic "walk to my target room's door" robustness for the plain patient movement legs
  // (toReception/toConsult/toTreatment). These previously called p.updateMovement(dt) directly
  // with whatever path was set once at the moment they entered the state - if that single
  // setPathToTile call happened to fail (room briefly unreachable, e.g. through a busy/crowded
  // layout), the patient was left walking nowhere forever with no retry, eventually dying in
  // place with no visible cause. This retries the path every frame while it's null (so
  // _giveUpIfStuck's fail-streak counter actually gets a chance to trip, same idea as the
  // "errand" state already did) and reports "stuck" so the caller can send them to leave
  // gracefully instead of freezing.
  _advancePatientToRoom(p, dt){
    const room = this.hospital.rooms.find(r=>r.id===p.targetRoomId);
    if(!room) return "stuck";
    if(!p.path){
      const door = this.hospital.doorWorld(room);
      p.setPathToTile(this.hospital, Math.floor(door.x/TILE), Math.floor(door.y/TILE));
    }
    if(this._giveUpIfStuck(p)) return "stuck";
    if(!p.path) return "waiting";
    return p.updateMovement(dt) ? "arrived" : "waiting";
  }

  // Creates a floor mess at a patient's current position - visible, dents reputation a little,
  // and persists until a janitor cleans it (see the "toClean"/"cleaning" staff states).
  _createMess(p){
    const tileX = clamp(Math.floor(p.x/TILE), 0, MAP_W-1);
    const tileY = clamp(Math.floor(p.y/TILE), 0, MAP_H-1);
    this.hospital.messes.push({
      id: uid(), x: p.x, y: p.y, tileX, tileY,
      type: p.diseaseKey==="theSquits" ? "poop" : "vomit",
      age: 0
    });
    this.hospitalReputation = clamp(this.hospitalReputation - 2, 0, 100);
    this.pushToast(p.name+" made a mess - it needs cleaning up.", "bad");
  }

  _nearestFountain(x,y){
    let best=null, bestD=Infinity;
    for(const o of this.hospital.objects){
      if(o.type!=="fountain") continue;
      const ow = this.hospital.objectWorld(o);
      const d = Math.hypot(ow.x-x, ow.y-y);
      if(d<bestD){ bestD=d; best=o; }
    }
    return best;
  }

  // Dispatches a patient on a quick fountain trip once thirst gets high, but only from a state
  // safe to interrupt (standing/seated in a queue) - never mid-consultation/treatment. If no
  // fountain exists anywhere, raises a hospital-wide warning instead of silently doing nothing.
  // Shared cleanup for leaving the "errand" state, whether it resolved normally or the patient
  // gave up trying to reach an unreachable target. Always restores their place in the queue.
  _returnFromErrand(p, gaveUp){
    if(!gaveUp && p.errandType==="thirst") p.thirst = 0;
    p.errandType = null;
    p.errandTargetTile = null;
    p._queueTargetKey = null; // force a fresh, safe path back to the queue slot
    const room = this.hospital.rooms.find(r=>r.id===p.errandRoomId);
    if(room && !room.queue.includes(p.id)) room.queue.unshift(p.id);
    p.errandRoomId = null;
    p.state = p.errandStateBefore || "leaving";
    if(!p.errandStateBefore) this._sendToExit(p);
    p.errandStateBefore = null;
  }

  _maybeDispatchThirstErrand(p){
    if(p.thirst < 70) return;
    if(!p.state || !p.state.startsWith("queue")) return;
    const fountain = this._nearestFountain(p.x, p.y);
    if(!fountain){
      this._noWaterWarning = true;
      return;
    }
    // Pull them out of the room's queue while they step away - queues only let index 0 be
    // served, so leaving a thirsty patient's ticket in place would freeze everyone behind them
    // the moment they wandered off. They're re-inserted at the front when they get back.
    const room = this.hospital.rooms.find(r=>r.id===p.targetRoomId);
    if(room) room.queue = room.queue.filter(id=>id!==p.id);
    p.errandRoomId = room? room.id : null;
    p.errandType = "thirst";
    p.errandStateBefore = p.state;
    p.errandTargetTile = { x: fountain.x, y: fountain.y };
    p.errandTimer = 2;
    p.setPathToTile(this.hospital, fountain.x, fountain.y);
    p.state = "errand";
  }

  // A patient whose health hits zero dies (design doc §1/§14) - a hard failure state, not just
  // an unhappy departure. Frees whatever they were holding onto and dents the hospital's
  // reputation, the lightweight stand-in for the original's full reputation system.
  // Frees up everyone currently working an Operating Theatre procedure for this patient - the
  // escort lead (workPhase reset so they don't stay stuck mid-"toDoor"/"atSlot") and any
  // assisting surgeons. Used whenever a treatment/consultation ends abnormally (room demolished,
  // patient dies mid-procedure) so staff never end up permanently stuck "busy" on a patient
  // who's no longer there.
  _releaseTreatmentTeam(p){
    const worker = this.staff.find(s=>s.currentPatientId===p.id);
    if(worker){ worker.state="idle"; worker.workPhase=null; worker.currentPatientId=null; worker.atSlot=true; }
    (p.assistingStaffIds||[]).forEach(id=>{
      const a = this.staff.find(s=>s.id===id);
      if(a){ a.state="idle"; a.workPhase=null; a.currentPatientId=null; a.atSlot=true; }
    });
    p.assistingStaffIds = [];
    p._teamSkill = null;
  }
  _patientDies(p){
    this._leaveWaitingRoom(p);
    if(p.targetRoomId){
      const r = this.hospital.rooms.find(x=>x.id===p.targetRoomId);
      if(r) r.queue = r.queue.filter(id=>id!==p.id);
    }
    this._releaseTreatmentTeam(p);
    this.hospitalReputation = clamp(this.hospitalReputation - 8, 0, 100);
    this.economy.totalDeaths = (this.economy.totalDeaths||0) + 1;
    this.pushToast(p.name+" has died. This hurts the hospital's reputation.", "bad", true);
    // The body stays right where they died - as a "body" mess, reusing the exact same
    // mess-cleanup system as vomit/poop (design feedback: bodies and messes should persist
    // until a janitor actually deals with them, not vanish on a fixed timer regardless of
    // whether anyone's come to clean up). It keeps costing a little reputation every tick it's
    // left lying around, same idea as an uncleaned mess, so ignoring it isn't free.
    const tileX = clamp(Math.floor(p.x/TILE), 0, MAP_W-1);
    const tileY = clamp(Math.floor(p.y/TILE), 0, MAP_H-1);
    this.hospital.messes.push({ id: uid(), x: p.x, y: p.y, tileX, tileY, type: "body", age: 0, patientId: p.id });
    p.state = "dead";
    p.path = null;
  }

  // standing in line without a seat costs mood, energy, and eventually health; a seat softens
  // that a lot. Nearby vending machines / fountains / plants (player-placed, see the Furniture
  // tab) further soften the standing penalty - a real, functional reason to place them well.
  _applyWaitEffects(p, dt, seated, room){
    let comfort = 1;
    if(room){
      const amenities = this.hospital.nearbyAmenityCount(room, ["vending","fountain","plant"]);
      comfort = clamp(1 - amenities*0.18, 0.35, 1);
    }
    if(seated){
      p.happiness = clamp(p.happiness - dt*0.25*comfort, 0, 100);
      p.energy = clamp(p.energy + dt*0.3, 0, 100);
    } else {
      p.happiness = clamp(p.happiness - dt*0.9*comfort, 0, 100);
      p.energy = clamp(p.energy - dt*1.0*comfort, 0, 100);
      if(p.energy < 20){
        p.health = clamp(p.health - dt*1.5, 0, 100);
      }
    }
  }
  _workerSkillFor(p){
    const con = this.hospital.rooms.find(r=>r.id===p.targetRoomId);
    if(!con) return 0;
    const doc = this.staff.find(s=>s.currentPatientId===p.id);
    return doc? doc.skill : 0;
  }
  // Machine cycle (design doc §17): new -> usage -> durability down -> warning -> breakdown ->
  // handyman -> repair. Called once per patient actually served in a room with equipment
  // (GAME_DATA rooms with a `machine` key - the diagnostic scanners, the Operating Theatre kit,
  // every specialty clinic's device). Breakdown risk rises as durability drops, matching a
  // fresh machine essentially never failing outright vs. a worn one increasingly doing so.
  _wearMachine(room){
    const machineKey = ROOM_TYPES[room.type].machine;
    if(!machineKey) return;
    const machine = MACHINE_TYPES[machineKey];
    if(!machine) return;
    room.machineDurability = clamp((room.machineDurability==null?100:room.machineDurability) - (3 + Math.random()*5), 0, 100);
    const wearFactor = 1 - room.machineDurability/100;
    if(!room.machineBroken && Math.random() < machine.breakdownChance * (0.4 + wearFactor*2.5)){
      room.machineBroken = true;
      this.pushToast("⚠ The "+machine.name+" in the "+ROOM_TYPES[room.type].name+" has broken down!", "bad");
    } else if(!room.machineBroken && room.machineDurability < 30 && !room._lowDurabilityWarned){
      room._lowDurabilityWarned = true;
      this.pushToast(machine.name+" in the "+ROOM_TYPES[room.type].name+" is wearing out - send a handyman soon.", "bad");
    }
    if(room.machineDurability >= 60) room._lowDurabilityWarned = false; // re-arm the warning
  }
  _isFrontOfQueue(room, p){ return room.queue[0]===p.id; }
  // Send Staff to Rest policy threshold (design doc §14/§27): below this energy, a staff member
  // should be heading to the Staff Room, not starting another patient. Centralized here so every
  // "who's free to serve" check agrees with the "idle" case's own decision to send them to rest -
  // without this, a room with a long queue could keep re-grabbing an idle-but-exhausted worker
  // for the next patient every single frame, and they'd never get the one truly idle tick needed
  // to actually notice they're due for rest and go (a real deadlock under sustained heavy load).
  _restThreshold(){
    return lerp(60, 8, this.policy.staffRestThreshold/100);
  }
  _isDueForRest(s){
    // A workaholic (high workEthic, from their hire profile - see openHireBrowser) pushes on
    // well past where a break-loving colleague would already have called it - an individual
    // trait layered on top of the global "Send Staff to Rest" policy, not a replacement for it.
    const ethic = s.workEthic!=null ? s.workEthic : 50;
    const personalFactor = lerp(1.4, 0.6, ethic/100); // lazy rests eagerly (higher effective threshold), workaholic waits (lower)
    return s.energy < this._restThreshold()*personalFactor;
  }
  _freeWorkerCount(room){
    return room.staffIds.filter(id=>{
      const s = this.staff.find(x=>x.id===id);
      return s && s.state==="idle" && s.atSlot && s.moving===false && !this._isDueForRest(s);
    }).length;
  }
  // A room with multiple staff (big enough room) can now serve multiple patients at once - a
  // patient is servable once there are enough free workers to reach their spot in line, not
  // only when they're literally first. Reception keeps its simple always-available shortcut.
  // Operating Theatre is the one exception: its 2+ staff work together on a single patient
  // (surgeonsRequired), so only the front of the queue can be served, and only once the whole
  // team is free at once - not two separate patients handled in parallel.
  _isServable(room, p){
    const idx = room.queue.indexOf(p.id);
    if(idx<0) return false;
    // A broken machine is a hard stop (design doc §17's "breakdown" state) - no one gets served
    // here until a handyman repairs it, same as being fully understaffed.
    if(room.machineBroken) return false;
    if(room._constructing || room._demolishing) return false;
    const def = ROOM_TYPES[room.type];
    if(!def.needsDoctor) return idx===0;
    if(def.surgeonsRequired>1) return idx===0 && this._freeWorkerCount(room) >= def.surgeonsRequired;
    return idx < this._freeWorkerCount(room);
  }
  _roomHasFreeWorker(room){
    return room.staffIds.some(id=>{
      const s = this.staff.find(x=>x.id===id);
      return s && s.state==="idle" && s.atSlot && s.moving===false && !this._isDueForRest(s);
    }) || !ROOM_TYPES[room.type].needsDoctor;
  }
  _getFreeWorker(room){
    for(const id of room.staffIds){
      const s = this.staff.find(x=>x.id===id);
      if(s && s.state==="idle" && s.atSlot && !this._isDueForRest(s)) return s;
    }
    return null;
  }
  // Same idea as _getFreeWorker but grabs a whole team at once (Operating Theatre's 2 surgeons)
  // - returns null rather than a partial team if there aren't enough free, so the caller never
  // ends up starting a procedure short-staffed. Highest-skill first so the primary "lead" escort
  // role (see queueTreatment) goes to the most skilled member of the team.
  _getFreeWorkers(room, n){
    const free = room.staffIds
      .map(id=>this.staff.find(x=>x.id===id))
      .filter(s=>s && s.state==="idle" && s.atSlot && !this._isDueForRest(s))
      .sort((a,b)=>b.skill-a.skill);
    return free.length>=n ? free.slice(0,n) : null;
  }
  // Queue slots sit outside a room, in corridor space that isn't guaranteed to be a straight
  // clear line - another room can easily end up built along that path. Route through the real
  // nav grid (respecting walls) to the slot's tile, then do a small direct nudge for exact
  // sub-tile alignment once there - that final step is always safe since it never leaves the tile.
  _updateQueueMotion(p, room, dt){
    const idx = room.queue.indexOf(p.id);
    if(idx<0) return;
    const slot = this.hospital.queueSlotWorld(room, idx);
    let tx = clamp(Math.floor(slot.x/TILE), 0, MAP_W-1);
    let ty = clamp(Math.floor(slot.y/TILE), 0, MAP_H-1);
    if(!this.hospital.isWalkable(tx,ty)){
      // desired spot got built over - fall back to stacking at the door tile instead of
      // cutting through whatever now occupies that space
      tx = room.door.x; ty = room.door.y;
    }
    const targetKey = tx+","+ty;
    if(p._queueTargetKey !== targetKey){
      p._queueTargetKey = targetKey;
      const curTile = { x:Math.floor(p.x/TILE), y:Math.floor(p.y/TILE) };
      if(curTile.x!==tx || curTile.y!==ty){
        p.setPathToTile(this.hospital, tx, ty);
      } else {
        p.path = null;
      }
    }
    if(p.path){
      p.updateMovement(dt);
    } else {
      p.moveToward(slot.x, slot.y, dt, p.speed);
    }
  }

  _sendToExit(p){
    const ent = this.hospital.entranceTile();
    p.setPathToTile(this.hospital, ent.x, ent.y);
  }

  _updateStaff(dt){
    for(const s of this.staff){
      // History log, same idea as patients above.
      if(s.state !== s._lastLoggedState){
        s._history = s._history || [];
        s._history.push({ t:this.simTime, label:this._staffStateLabel(s.state) });
        if(s._history.length>60) s._history.shift();
        s._lastLoggedState = s.state;
      }
      // thirst (staff, like patients) rises the whole shift; only interrupted from a genuinely
      // idle moment, never mid-treatment or mid-repair
      if(s.state!=="toDrink" && s.state!=="drinking"){
        s.thirst = clamp((s.thirst||0) + 0.35*dt, 0, 100);
        if(s.thirst>=100) s.energy = clamp(s.energy - dt*1.2, 0, 100);
      }
      // Consequence of a high Send Staff to Rest threshold: working exhausted (very low energy,
      // still actively on the job) makes mistakes more likely and, if sustained, risks the
      // staff member resigning outright - matches the policy's own description.
      if(s.energy<15 && (s.state==="working" || s.state==="repairing" || s.state==="cleaning")){
        s.fatigueStrain = (s.fatigueStrain||0) + dt;
        if(s.fatigueStrain > 90){
          this.staff = this.staff.filter(x=>x.id!==s.id);
          if(s.assignedRoomId){
            const r = this.hospital.rooms.find(x=>x.id===s.assignedRoomId);
            if(r) r.staffIds = r.staffIds.filter(id=>id!==s.id);
          }
          this.pushToast(s.name+" resigned - pushed too hard for too long. Lower the Send Staff to Rest threshold.", "bad");
          continue;
        }
      } else {
        s.fatigueStrain = Math.max(0, (s.fatigueStrain||0) - dt*2);
      }
      switch(s.state){
        case "idle": {
          // Freshly hired, just-assigned staff wait out their onboarding delay before the
          // normal idle routine (walking to work, resting, etc.) applies to them at all.
          if(s.pendingHire){
            s.pendingHireTimer -= dt;
            if(s.pendingHireTimer<=0){ s.pendingHire = false; }
            break;
          }
          // Send Staff to Rest check runs FIRST, before dispatching to any new task (thirst
          // run, mess cleanup, room repair, or walking back to their desk). This ordering
          // matters: a staff member whose task keeps failing - most importantly a genuinely
          // unreachable assigned room (see toWork's retry/give-up loop below) - would otherwise
          // retry every single frame and never get a genuinely idle tick to notice they're due
          // for rest, draining straight to 0 energy and getting permanently stuck instead of
          // recovering via the Staff Room like they're supposed to.
          if(this._isDueForRest(s)){
            s.state="toRest"; s.atSlot=false;
            break;
          }
          if(s.thirst>=75 && s.atSlot){
            const fountain = this._nearestFountain(s.x, s.y);
            if(fountain){
              s.state = "toDrink"; s.path=null;
              s.setPathToTile(this.hospital, fountain.x, fountain.y);
              s.atSlot = false;
              break;
            } else {
              this._noWaterWarning = true;
            }
          }
          // Janitors prioritize a mess to clean, then a room that needs repair, over their
          // normal desk routine - messes are the more urgent/visible problem.
          if(s.type==="maintenance" && !s.repairRoomId && !s.cleaningMessId){
            // Explicit task queue (design feedback: no way to see or reorder what a busy
            // handyman is queued up to do next - "if he's called to room A then room B, he
            // should do A first"). Player-requested repairs (via the room panel's "Call
            // handyman" button when everyone was already busy) land at the front of this list;
            // anything still in it takes priority over the automatic mess/worst-condition scan
            // below, and it's directly editable from the handyman's own detail panel.
            if(s._taskQueue && s._taskQueue.length){
              const task = s._taskQueue.shift();
              const room = this.hospital.rooms.find(r=>r.id===task.roomId);
              if(room && (room.machineBroken || (room.condition??100)<100)){
                s.repairRoomId = room.id;
                s.setPathToTile(this.hospital, room.door.x, room.door.y);
                s.state = "toRepair";
                s.atSlot = false;
                break;
              }
              // room got fixed/demolished/removed by the time we got to it - just fall through
              // to the normal automatic scan below instead of stalling on a stale task
            }
            const mess = this.hospital.messes[0];
            if(mess){
              s.cleaningMessId = mess.id;
              s.setPathToTile(this.hospital, mess.tileX, mess.tileY);
              s.state = "toClean";
              s.atSlot = false;
              break;
            }
            const broken = this.hospital.rooms
              .filter(r=>r.machineBroken || (r.condition??100) < 80)
              .sort((a,b)=>{
                // broken machines are urgent (the room is fully unusable) - always jump the queue
                // ahead of merely-worn rooms that are still degraded-but-functional
                const aBroken = a.machineBroken?1:0, bBroken = b.machineBroken?1:0;
                if(aBroken!==bBroken) return bBroken-aBroken;
                return (a.condition??100)-(b.condition??100);
              })[0];
            if(broken){
              s.repairRoomId = broken.id;
              s.setPathToTile(this.hospital, broken.door.x, broken.door.y);
              s.state = "toRepair";
              s.atSlot = false;
              break;
            }
          }
          const room = this.hospital.rooms.find(r=>r.id===s.assignedRoomId);
          if(room && !s.atSlot && !s.path){
            // walk to the door via the nav grid, then across the threshold to the desk/slot
            s.setPathToTile(this.hospital, room.door.x, room.door.y);
            s.state="toWork";
          }
          s.energy = clamp(s.energy - dt*0.12, 0, 100);
          break;
        }
        case "toRepair": {
          if(this._giveUpIfStuck(s)){ s.state="repairing"; s.path=null; break; }
          const done = s.updateMovement(dt);
          if(done){ s.state="repairing"; }
          break;
        }
        case "repairing": {
          const room = this.hospital.rooms.find(r=>r.id===s.repairRoomId);
          if(!room){ s.state="idle"; s.repairRoomId=null; break; }
          room.condition = clamp((room.condition==null?100:room.condition) + dt*7, 0, 100);
          // A broken machine also needs its durability restored, not just the room's general
          // condition - repairing takes a bit longer when there's an actual machine to fix
          // (matches GAME_DATA.machines[key].repairTime being longer than a plain room refresh).
          if(room.machineDurability!=null){
            room.machineDurability = clamp(room.machineDurability + dt*5, 0, 100);
            if(room.machineDurability>=100) room.machineBroken = false;
          }
          s.energy = clamp(s.energy - dt*0.2, 0, 100);
          const machineDone = room.machineDurability==null || room.machineDurability>=100;
          if((room.condition>=100 && machineDone) || s.energy<25){
            s.state="idle"; s.repairRoomId=null; s.path=null;
          }
          break;
        }
        case "toClean": {
          const mess = this.hospital.messes.find(m=>m.id===s.cleaningMessId);
          if(!mess){ s.state="idle"; s.cleaningMessId=null; break; }
          if(this._giveUpIfStuck(s)){ s.state="cleaning"; s.path=null; s.stateTimer=2; break; }
          const done = s.updateMovement(dt);
          if(done){ s.state="cleaning"; s.stateTimer=2; }
          break;
        }
        case "cleaning": {
          s.stateTimer -= dt;
          s.energy = clamp(s.energy - dt*0.15, 0, 100);
          if(s.stateTimer<=0){
            const mess = this.hospital.messes.find(m=>m.id===s.cleaningMessId);
            // A "body" mess additionally clears the deceased patient once actually cleaned up -
            // they were kept in state "dead" (still rendered, lying there) specifically so this
            // moment is what removes them, not a fixed timer that ran regardless of whether a
            // janitor ever showed up.
            if(mess && mess.type==="body"){
              const p = this.patients.find(x=>x.id===mess.patientId);
              if(p) p.state = "gone";
            }
            this.hospital.messes = this.hospital.messes.filter(m=>m.id!==s.cleaningMessId);
            s.cleaningMessId = null;
            s.state = "idle";
          }
          break;
        }
        case "toDrink": {
          if(this._giveUpIfStuck(s)){ s.state="idle"; s.path=null; break; }
          const done = s.updateMovement(dt);
          if(done){ s.state="drinking"; s.stateTimer=1.5; }
          break;
        }
        case "drinking": {
          s.stateTimer -= dt;
          if(s.stateTimer<=0){ s.thirst=0; s.state="idle"; }
          break;
        }
        case "toWork": {
          // Robustness fix: unlike the escort/errand states, this case previously never checked
          // for a failed pathfind (room.door genuinely unreachable - e.g. built into a pocket,
          // or a later build sealed off the only corridor to it). A null path here used to leave
          // staff stuck in "toWork" forever with nothing retrying it. Now it retries the path a
          // few times and, if still unreachable, drops back to idle so the normal idle-state
          // retry logic gets another chance next tick instead of a permanent soft-lock.
          if(!s.path){
            const room = this.hospital.rooms.find(r=>r.id===s.assignedRoomId);
            if(this._giveUpIfStuck(s)){ s.state="idle"; s._pathFailStreak=0; break; }
            if(room) s.setPathToTile(this.hospital, room.door.x, room.door.y);
            if(!s.path) break;
          }
          const done = s.updateMovement(dt);
          if(done){ s.state="enteringRoom"; }
          s.energy = clamp(s.energy - dt*0.12, 0, 100);
          break;
        }
        case "enteringRoom": {
          const room = this.hospital.rooms.find(r=>r.id===s.assignedRoomId);
          if(!room){ s.state="idle"; break; }
          const slot = this.hospital.staffSlotWorld(room, s.slotIndex);
          const done = s.moveToward(slot.x, slot.y, dt, s.speed);
          if(done){ s.atSlot=true; s.state="idle"; }
          break;
        }
        case "working": {
          s.energy = clamp(s.energy - dt*0.6, 0, 100);
          const room = this.hospital.rooms.find(r=>r.id===s.assignedRoomId);
          if(!room){ s.state="idle"; s.workPhase=null; s.currentPatientId=null; break; }
          switch(s.workPhase){
            case "toDoor": {
              // walk to the door to greet the incoming patient - the patient waits there until
              // this leg completes (see the arrivedAtSlot gate in beingConsulted/beingTreated).
              // Escort legs move at a hurried pace (ESCORT_SPEED_MULT): the greet/see-out walk
              // is there for visible dynamism, not to eat into how many patients get seen - at
              // normal walking speed this overhead nearly halved total treatment throughput.
              if(!s.path) s.setPathToTile(this.hospital, room.door.x, room.door.y);
              if(this._giveUpIfStuck(s)){ s.workPhase="toSlot"; s.path=null; break; }
              const done = s.updateMovement(dt, s.speed*Game.ESCORT_SPEED_MULT);
              if(done) s.workPhase="atDoor";
              break;
            }
            case "atDoor": {
              // greeted - once the patient has actually been let loose to walk in, escort them
              // by heading to the staff slot alongside them. If the patient vanished before we
              // got here (left unhappy, died, etc.) don't wait forever - head back.
              const p = this.patients.find(x=>x.id===s.pendingGreetId);
              if(p && (p.state==="beingConsulted"||p.state==="beingTreated")) s.workPhase = "toSlot";
              else if(!p){ s.workPhase="seeingOut"; s.path=null; }
              break;
            }
            case "toSlot": {
              const slot = this.hospital.staffSlotWorld(room, s.slotIndex);
              if(s.moveToward(slot.x, slot.y, dt, s.speed*Game.ESCORT_SPEED_MULT)) s.workPhase="atSlot";
              break;
            }
            case "atSlot": {
              // holding position at the desk/bed while the patient's own service timer runs -
              // nothing to do here, just stay put until the patient state machine flips us to
              // "seeingOut" on completion
              break;
            }
            case "seeingOut": {
              if(!s.path) s.setPathToTile(this.hospital, room.door.x, room.door.y);
              if(this._giveUpIfStuck(s)){ s.workPhase="returning"; s.path=null; break; }
              const done = s.updateMovement(dt, s.speed*Game.ESCORT_SPEED_MULT);
              if(done) s.workPhase="returning";
              break;
            }
            case "returning": {
              const slot = this.hospital.staffSlotWorld(room, s.slotIndex);
              if(s.moveToward(slot.x, slot.y, dt, s.speed*Game.ESCORT_SPEED_MULT)){
                s.state="idle"; s.workPhase=null; s.atSlot=true; s.pendingGreetId=null;
              }
              break;
            }
            default: s.workPhase="atSlot"; // safety net for any legacy/edge state
          }
          break;
        }
        case "toRest": {
          const restRoom = this.hospital.roomsOfType("staffroom")[0];
          if(restRoom){
            // Robustness (same class of fix as "toWork"): if the Staff Room is genuinely
            // unreachable - walled off, or the path keeps failing for any reason - a tired
            // staff member must not get stuck here forever with literally no way to recover.
            // Unlike toWork (where giving up just means "try idle again later"), getting stuck
            // in toRest with zero energy and zero recovery is worse: nothing else the sim does
            // can rescue them, so this needs its own safety net rather than relying on the
            // shared idle-case fix. After enough failed path attempts, let them recover in
            // place - same fallback already used when no staffroom exists at all.
            if(this._giveUpIfStuck(s)){
              s.energy = clamp(s.energy+dt*4,0,100);
              if(s.energy>60){ s.state="idle"; s.path=null; s._pathFailStreak=0; }
              break;
            }
            if(!s.path){
              s.setPathToTile(this.hospital, restRoom.door.x, restRoom.door.y);
              // trickle-recover even while a path attempt is pending, so a staff member isn't
              // frozen at exactly 0 energy for the several seconds it takes to give up
              s.energy = clamp(s.energy+dt*1, 0, 100);
              break;
            }
            const done = s.updateMovement(dt);
            if(done){
              const restIdx = this.hospital.freeStaffSlotIndex(restRoom, this.staff, s.id);
              const slot = this.hospital.staffSlotWorld(restRoom, restIdx);
              s.x = slot.x + (Math.random()-0.5)*8; s.y = slot.y + (Math.random()-0.5)*8;
              s.state="resting"; s.stateTimer=0;
            }
          } else {
            s.energy = clamp(s.energy+dt*4,0,100);
            if(s.energy>60) s.state="idle";
          }
          break;
        }
        case "resting": {
          s.energy = clamp(s.energy + dt*12, 0, 100);
          if(s.energy>=95){ s.state="idle"; s.path=null; s.atSlot=false; }
          break;
        }
      }
      s.animT += dt;
    }
  }

  /* ---------------- render ---------------- */
  _buildGrassPattern(){
    const size = 48;
    const c = document.createElement("canvas");
    c.width = size; c.height = size;
    const gctx = c.getContext("2d");
    gctx.fillStyle = "#3f7a3b";
    gctx.fillRect(0,0,size,size);
    // fixed pseudo-random blades, generated once - a real per-frame random fill would flicker
    for(let i=0;i<34;i++){
      const x = (i*17)%size + (i*7)%6;
      const y = (i*29)%size + (i*11)%6;
      gctx.strokeStyle = i%3===0? "#5a9e52" : (i%3===1? "#2f5f2a":"#4a8a44");
      gctx.lineWidth = 1.3;
      gctx.beginPath();
      gctx.moveTo(x,y);
      gctx.lineTo(x+2-(i%5), y-5-(i%4));
      gctx.stroke();
    }
    // a few small darker tufts for texture
    for(let i=0;i<10;i++){
      const x = (i*23+9)%size, y=(i*31+13)%size;
      gctx.fillStyle = "rgba(0,0,0,.06)";
      gctx.beginPath(); gctx.ellipse(x,y,3,1.6,0,0,Math.PI*2); gctx.fill();
    }
    this.grassPattern = this.ctx.createPattern(c, "repeat");
  }

  // Smoothly moves the camera toward a followed staff/patient/room each frame (see
  // followTarget, set by _openSelection or _openRoomInfo on a fresh tap). Lerped rather than
  // snapped so it reads as the camera tracking them, not jumping every time they take a step;
  // stops gracefully if they've left/died/been removed since the follow started. A room is
  // static so it just settles once and stays, same mechanism either way.
  _updateCameraFollow(){
    if(!this.followTarget) return;
    let iso = null;
    if(this.followTarget.kind==="staff"){
      const s = this.staff.find(s=>s.id===this.followTarget.id);
      if(!s){ this.followTarget = null; return; }
      iso = gridToScreen(s.x/TILE, s.y/TILE);
    } else if(this.followTarget.kind==="patient"){
      const p = this.patients.find(p=>p.id===this.followTarget.id && p.state!=="gone");
      if(!p){ this.followTarget = null; return; }
      iso = gridToScreen(p.x/TILE, p.y/TILE);
    } else if(this.followTarget.kind==="room"){
      const r = this.hospital.rooms.find(r=>r.id===this.followTarget.id);
      if(!r){ this.followTarget = null; return; }
      iso = gridToScreen((r.x0+r.x1)/2, (r.y0+r.y1)/2);
    }
    if(!iso) return;
    const followSpeed = 0.12;
    this.camera.x += (iso.x - this.camera.x) * followSpeed;
    this.camera.y += (iso.y - this.camera.y) * followSpeed;
  }

  render(){
    this._updateCameraFollow();
    const ctx = this.ctx;
    const w = this.canvas.width/DPR, h = this.canvas.height/DPR;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = "#141a26";
    ctx.fillRect(0,0,w,h);

    ctx.save();
    ctx.translate(w/2, h/2 - this.camera.vOffset);
    ctx.scale(this.camera.zoom, this.camera.zoom);
    ctx.translate(-this.camera.x, -this.camera.y);

    // grass fills everything - the floor diamonds and boundary walls drawn afterward cover
    // the hospital itself, so grass only ever shows in the space around the building
    ctx.fillStyle = this.grassPattern || "#3f7a3b";
    ctx.fillRect(-2500, -2500, 5000, 5000);

    this._drawFloor(ctx);
    this._drawBuildOverlay(ctx);
    if(this.showPaths) this._drawPathOverlays(ctx);

    const drawables = this._buildDepthDrawables(ctx);
    drawables.sort((a,b)=>a.depth-b.depth);
    for(const d of drawables) d.fn(ctx);

    if(this.showRoomNames) this._drawRoomLabels(ctx);
    this._drawFloatingTexts(ctx);

    ctx.restore();
  }

  _drawFloatingTexts(ctx){
    for(const f of this.floatingTexts){
      const t = f.age / f.duration; // 0..1
      const scr = gridToScreen(f.x/TILE, f.y/TILE);
      const riseY = scr.y - HUMANOID_GROUND_OFFSET - 20 - t*22;
      const alpha = t<0.15? t/0.15 : 1 - (t-0.15)/0.85;
      ctx.save();
      ctx.globalAlpha = clamp(alpha,0,1);
      if(f.kind==="money"){
        // A little green bill instead of plain floating text (design feedback) - rises and
        // fades exactly like before, plus a gentle wobble so it reads as tumbling up rather
        // than sliding on rails.
        const wobble = Math.sin(t*9)*4;
        ctx.translate(scr.x+wobble, riseY);
        ctx.rotate(Math.sin(t*7)*0.12);
        ctx.fillStyle = "rgba(0,0,0,.25)";
        ctx.fillRect(-17.5,-9.5,35,19);
        ctx.fillStyle = "#3f9a4d";
        ctx.fillRect(-18,-10,35,19);
        ctx.strokeStyle = "#dff2df"; ctx.lineWidth = 1.4;
        ctx.strokeRect(-15.5,-7.7,30,14.4);
        ctx.fillStyle = "rgba(255,255,255,.18)";
        ctx.beginPath(); ctx.ellipse(0,-0.5,7,6,0,0,Math.PI*2); ctx.fill();
        ctx.fillStyle = "#eafbe9";
        ctx.font = "bold 10.5px sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(f.text, 0, 0);
        ctx.restore();
        continue;
      }
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(0,0,0,.4)";
      ctx.fillText(f.text, scr.x+0.6, riseY+0.6);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, scr.x, riseY);
      ctx.restore();
    }
  }

  // Debug aid (Settings > Show pathfinding): draws each moving character's remaining path as a
  // dashed line + dots on the floor, in the same iso-projected space as everything else, so any
  // path that appears to cut through a wall is immediately obvious and easy to report precisely.
  _drawPathOverlays(ctx){
    const colors = ["#ff6b6b","#5fd6c8","#ffd166","#a29bfe","#66d97a","#ff9f6b","#6bc9ff"];
    const all = [...this.patients, ...this.staff];
    const selectedId = this.selected && (this.selected.kind==="patient"||this.selected.kind==="staff")
      ? this.selected.entity.id : null;
    for(const e of all){
      if(!e.path || e.path.length===0) continue;
      const isSelected = e.id===selectedId;
      const color = isSelected? "#ffe14d" : this._pick(e.id, colors, "pathColor");
      ctx.save();
      ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.lineWidth = isSelected? 3.5 : 2;
      ctx.globalAlpha = isSelected? 1 : 0.75;
      ctx.setLineDash(isSelected? [] : [5,4]);
      ctx.beginPath();
      const start = gridToScreen(e.x/TILE, e.y/TILE);
      ctx.moveTo(start.x, start.y);
      for(let i=e.pathIndex; i<e.path.length; i++){
        const node = e.path[i];
        const p = gridToScreen(node.x+0.5, node.y+0.5);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      for(let i=e.pathIndex; i<e.path.length; i++){
        const node = e.path[i];
        const p = gridToScreen(node.x+0.5, node.y+0.5);
        ctx.beginPath();
        ctx.arc(p.x, p.y, i===e.path.length-1? (isSelected?6:4.5) : (isSelected?3.4:2.4), 0, Math.PI*2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  _drawFloor(ctx){
    // floor diamonds, painter's-algorithm order (doesn't actually matter for depth since
    // floor is flat, but keeping it consistent with everything else)
    for(let sum=0; sum<=(MAP_W+MAP_H); sum++){
      for(let y=0;y<MAP_H;y++){
        const x = sum-y;
        if(x<0||x>=MAP_W) continue;
        const room = this.hospital.roomAt(x,y);
        if(room){
          // Room floors get a denser 2x2 "carpet" checker (design feedback: rooms should look
          // radically different from the plain corridor, not just a tinted version of the same
          // single-diamond-per-tile pattern) using heavily saturated colors instead of the raw
          // pastel def.color/darkColor, so each room type actually pops and reads distinctly at
          // a glance.
          const def = ROOM_TYPES[room.type];
          const carpetA = shadeForCondition(boostColor(def.color, 2.4, -0.06), room.condition);
          const carpetB = shadeForCondition(boostColor(def.darkColor, 2.2, -0.1), room.condition);
          for(let si=0; si<2; si++){
            for(let sj=0; sj<2; sj++){
              const sp = gridToScreen(x+si*0.5, y+sj*0.5);
              ctx.beginPath();
              ctx.moveTo(sp.x, sp.y);
              ctx.lineTo(sp.x+TW/4, sp.y+TH/4);
              ctx.lineTo(sp.x, sp.y+TH/2);
              ctx.lineTo(sp.x-TW/4, sp.y+TH/4);
              ctx.closePath();
              ctx.fillStyle = ((x*2+si)+(y*2+sj))%2===0 ? carpetA : carpetB;
              ctx.fill();
            }
          }
          ctx.strokeStyle="rgba(0,0,0,.06)"; ctx.lineWidth=0.75;
          const p = gridToScreen(x,y);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y); ctx.lineTo(p.x+TW/2, p.y+TH/2);
          ctx.lineTo(p.x, p.y+TH); ctx.lineTo(p.x-TW/2, p.y+TH/2);
          ctx.closePath(); ctx.stroke();
          continue;
        }
        const p = gridToScreen(x,y);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x+TW/2, p.y+TH/2);
        ctx.lineTo(p.x, p.y+TH);
        ctx.lineTo(p.x-TW/2, p.y+TH/2);
        ctx.closePath();
        if(!this.hospital.inFootprint(x,y,1,1)){
          // Outside the T-shaped hospital grounds entirely (the "cut corners" of the map) -
          // filled with the same textured grass pattern as the exterior beyond the map edges
          // (design feedback: this used to be a flat, slightly different green that didn't
          // actually read as "grass" next to the real textured exterior - now it's visually
          // one continuous lawn right up to the building's own footprint).
          ctx.fillStyle = this.grassPattern || "#3f7a3b";
        } else {
          ctx.fillStyle = ((x+y)%2===0)? "#cfc7ae" : "#bdb59d";
        }
        ctx.fill();
        ctx.strokeStyle="rgba(0,0,0,.08)"; ctx.lineWidth=1; ctx.stroke();
      }
    }
    // door threshold tiles get a light tint, so the opening is easy to spot at a glance
    for(const r of this.hospital.rooms){
      const y = r.doorSide==="north"? r.y0 : r.y1-1;
      for(let x=r.doorFrom;x<r.doorTo;x++){
        const p = gridToScreen(x,y);
        ctx.beginPath();
        ctx.moveTo(p.x,p.y); ctx.lineTo(p.x+TW/2,p.y+TH/2); ctx.lineTo(p.x,p.y+TH); ctx.lineTo(p.x-TW/2,p.y+TH/2);
        ctx.closePath();
        ctx.fillStyle="rgba(255,255,255,.32)"; ctx.fill();
      }
    }

    // Under-construction / being-demolished overlay: a tinted hatch-like wash over every tile
    // of the room, plus a small countdown label, so the state is legible even at a glance and
    // even while walls are hidden (build/furniture mode).
    for(const r of this.hospital.rooms){
      if(!r._constructing && !r._demolishing) continue;
      for(let x=r.x0;x<r.x1;x++){
        for(let y=r.y0;y<r.y1;y++){
          const p = gridToScreen(x,y);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y); ctx.lineTo(p.x+TW/2,p.y+TH/2); ctx.lineTo(p.x,p.y+TH); ctx.lineTo(p.x-TW/2,p.y+TH/2);
          ctx.closePath();
          ctx.fillStyle = r._constructing ? "rgba(230,180,60,0.4)" : "rgba(70,70,70,0.5)";
          ctx.fill();
        }
      }
      const center = gridToScreen((r.x0+r.x1)/2, (r.y0+r.y1)/2);
      ctx.save();
      ctx.font = "700 11px sans-serif";
      ctx.textAlign = "center";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,.65)";
      ctx.fillStyle = "#fff";
      const label = r._constructing ? "🚧 "+Math.ceil(r._constructionTimer)+"s" : "🧱 "+Math.ceil(r._demolishTimer)+"s";
      ctx.strokeText(label, center.x, center.y+TH/2-40);
      ctx.fillText(label, center.x, center.y+TH/2-40);
      ctx.restore();
    }

    // While walls are hidden (build/furniture placement mode), the room footprints would
    // otherwise be hard to make out - a bold outline on the floor keeps every existing room's
    // boundary legible even without walls to mark it.
    if(this.buildMode || this.placeMode){
      ctx.save();
      ctx.strokeStyle = "rgba(0,0,0,.8)";
      ctx.lineWidth = 3;
      for(const r of this.hospital.rooms){
        const c0=gridToScreen(r.x0,r.y0), c1=gridToScreen(r.x1,r.y0), c2=gridToScreen(r.x1,r.y1), c3=gridToScreen(r.x0,r.y1);
        ctx.beginPath();
        ctx.moveTo(c0.x,c0.y); ctx.lineTo(c1.x,c1.y); ctx.lineTo(c2.x,c2.y); ctx.lineTo(c3.x,c3.y);
        ctx.closePath();
        ctx.stroke();
      }
      // The hospital's own outer walls are also fully hidden right now (see
      // _pushBoundaryWalls) - trace the whole T-shaped footprint the same bold way, so the
      // building's outline stays legible while placing something near its edge. The door gap
      // stays visible on its own (drawn separately, unaffected by hideAll).
      ctx.strokeStyle = "rgba(0,0,0,.85)";
      ctx.lineWidth = 4;
      const pts = this._hospitalOutlinePoints();
      ctx.beginPath();
      pts.forEach((p,i)=>{ const s=gridToScreen(p.x,p.y); i===0? ctx.moveTo(s.x,s.y): ctx.lineTo(s.x,s.y); });
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }

  // Everything with height - walls, wall decor, hidden-side door markers, furniture clusters,
  // waiting-area vending props, and every character - goes through this single depth-sorted
  // list and is painted back-to-front in one pass. This is the exact technique validated in the
  // iso preview: splitting each wall run into one drawable per grid unit (instead of one per
  // whole run) keeps depth exact even for long runs, so a character is never wrongly sorted in
  // front of a wall it should be standing behind.
  _buildDepthDrawables(ctx){
    const drawables = [];
    // Every room's north/west wall is always drawn (that's what lets the camera see inside via
    // culled south/east walls). For two directly-adjacent rooms sharing a boundary, that means
    // the "southern"/"eastern" room's near (north/west) wall already covers that exact segment -
    // so when "Show south/east walls" is on, the "northern"/"western" room must NOT also draw
    // its far (south/east) wall there, or the two overlap at identical depth and whichever room
    // happens to be later in the array (i.e. most recently built) wins the render order by pure
    // chance. Precomputing every near-wall segment up front lets the south/east push functions
    // below skip a segment a neighboring room already owns - the neighboring room is always the
    // one actually closer to the camera, matching how a real shared wall should read.
    const nearWallSegments = new Set();
    for(const r of this.hospital.rooms){
      for(let x=r.x0;x<r.x1;x++) nearWallSegments.add("N:"+x+","+r.y0);
      for(let y=r.y0;y<r.y1;y++) nearWallSegments.add("W:"+r.x0+","+y);
    }
    const pushNorthRun = (r,a,b,color)=>{
      for(let x=a;x<b;x++) drawables.push({ depth:x+0.5+r.y0, fn:(ctx)=>wallQuad(ctx,x,r.y0,x+1,r.y0,color) });
    };
    const pushWestRun = (r,a,b,color)=>{
      for(let y=a;y<b;y++) drawables.push({ depth:r.x0+y+0.5, fn:(ctx)=>wallQuad(ctx,r.x0,y,r.x0,y+1,color) });
    };
    // south/east are culled by default (that's what lets the camera see inside rooms), but the
    // Settings toggle can force them on so the player can see exactly what's normally hidden -
    // each segment is skipped if a neighboring room's near wall already owns it (see above).
    const pushSouthRun = (r,a,b,color)=>{
      for(let x=a;x<b;x++){
        if(nearWallSegments.has("N:"+x+","+r.y1)) continue;
        drawables.push({ depth:x+0.5+r.y1, fn:(ctx)=>wallQuad(ctx,x,r.y1,x+1,r.y1,color) });
      }
    };
    const pushEastRun = (r,a,b,color)=>{
      for(let y=a;y<b;y++){
        if(nearWallSegments.has("W:"+r.x1+","+y)) continue;
        drawables.push({ depth:r.x1+y+0.5, fn:(ctx)=>wallQuad(ctx,r.x1,y,r.x1,y+1,color) });
      }
    };

    for(const r of this.hospital.rooms){
      const def = ROOM_TYPES[r.type];
      // Radically more saturated/darker than the room's floor tone (design feedback: walls
      // should look dramatically distinct per room type, not just a muted shade of the floor).
      const wallColor = shadeForCondition(boostColor(def.darkColor, 2.6, -0.22), r.condition);

      // While placing a room or furniture, hide every wall entirely - much easier to see the
      // whole floor plan and line things up than working around walls in the iso view.
      const hideWalls = !!(this.buildMode || this.placeMode);
      if(!hideWalls){
      // north wall (visible/far side) - always solid in this game, no door ever placed here
      if(r.doorSide==="north"){
        if(r.doorFrom>r.x0){ pushNorthRun(r,r.x0,r.doorFrom,wallColor); pushWallDecor(drawables,r,"north",r.x0,r.doorFrom); }
        if(r.doorTo<r.x1){ pushNorthRun(r,r.doorTo,r.x1,wallColor); pushWallDecor(drawables,r,"north",r.doorTo,r.x1); }
        drawables.push({ depth:r.y0+(r.doorFrom+r.doorTo)/2, fn:(ctx)=>drawDoorOnWall(ctx,r.doorFrom,r.y0,r.doorTo,r.y0,WALL_H,r._doorOpenAmount) });
      } else {
        pushNorthRun(r, r.x0, r.x1, wallColor);
        pushWallDecor(drawables, r, "north", r.x0, r.x1);
      }
      // west wall (visible/far side) - always solid
      if(r.doorSide==="west"){
        if(r.doorFrom>r.y0){ pushWestRun(r,r.y0,r.doorFrom,wallColor); pushWallDecor(drawables,r,"west",r.y0,r.doorFrom); }
        if(r.doorTo<r.y1){ pushWestRun(r,r.doorTo,r.y1,wallColor); pushWallDecor(drawables,r,"west",r.doorTo,r.y1); }
        drawables.push({ depth:r.x0+(r.doorFrom+r.doorTo)/2, fn:(ctx)=>drawDoorOnWall(ctx,r.x0,r.doorFrom,r.x0,r.doorTo,WALL_H,r._doorOpenAmount) });
      } else {
        pushWestRun(r, r.y0, r.y1, wallColor);
        pushWallDecor(drawables, r, "west", r.y0, r.y1);
      }
      // the door itself always ends up on a hidden (south) wall in this game, so it never
      // gets a full frame - just corner-post markers, same as the iso preview's convention
      if(r.doorSide==="south" || r.doorSide==="east"){
        const span = doorGridSpan(r);
        const d = (span.gx1+span.gx2)/2 + (span.gy1+span.gy2)/2;
        drawables.push({ depth:d+0.01, fn:(ctx)=>drawHiddenDoorMarker(ctx, span.gx1,span.gy1,span.gx2,span.gy2) });
      }
      if(this.showHiddenWalls){
        if(r.doorSide==="south"){
          if(r.doorFrom>r.x0) pushSouthRun(r,r.x0,r.doorFrom,wallColor);
          if(r.doorTo<r.x1) pushSouthRun(r,r.doorTo,r.x1,wallColor);
          drawables.push({ depth:r.y1+(r.doorFrom+r.doorTo)/2, fn:(ctx)=>drawDoorOnWall(ctx,r.doorFrom,r.y1,r.doorTo,r.y1,WALL_H,r._doorOpenAmount) });
          if(r.doorFrom>r.x0) pushWallDecor(drawables, r, "south", r.x0, r.doorFrom);
          if(r.doorTo<r.x1) pushWallDecor(drawables, r, "south", r.doorTo, r.x1);
        } else {
          pushSouthRun(r, r.x0, r.x1, wallColor);
          pushWallDecor(drawables, r, "south", r.x0, r.x1);
        }
        if(r.doorSide==="east"){
          if(r.doorFrom>r.y0) pushEastRun(r,r.y0,r.doorFrom,wallColor);
          if(r.doorTo<r.y1) pushEastRun(r,r.doorTo,r.y1,wallColor);
          drawables.push({ depth:r.x1+(r.doorFrom+r.doorTo)/2, fn:(ctx)=>drawDoorOnWall(ctx,r.x1,r.doorFrom,r.x1,r.doorTo,WALL_H,r._doorOpenAmount) });
          if(r.doorFrom>r.y0) pushWallDecor(drawables, r, "east", r.y0, r.doorFrom);
          if(r.doorTo<r.y1) pushWallDecor(drawables, r, "east", r.doorTo, r.y1);
        } else {
          pushEastRun(r, r.y0, r.y1, wallColor);
          pushWallDecor(drawables, r, "east", r.y0, r.y1);
        }
      }
      }
      if(hideWalls){
        // walls are gone, but the door position still needs to be visible so the player can
        // see where patients will actually enter/exit while lining up the next room
        const span = doorGridSpan(r);
        const d = (span.gx1+span.gx2)/2 + (span.gy1+span.gy2)/2;
        drawables.push({ depth:d+0.01, fn:(ctx)=>drawHiddenDoorMarker(ctx, span.gx1,span.gy1,span.gx2,span.gy2) });
      }

      // furniture, each part positioned at its own fractional spot in the room and projected
      // individually - correctly depth-sorts against characters piece by piece
      if(def.furniture){
        const offset = r.furnitureOffset || {dx:0, dy:0};
        for(const part of furnitureParts(r, def)){
          // Clamped so a nudge can't push furniture through a wall - stays within the room's
          // own floor area regardless of how far the player pushes it.
          const fx = clamp(part.fx+offset.dx, 0.08, 0.92), fy = clamp(part.fy+offset.dy, 0.08, 0.92);
          const gx = r.x0 + r.w*fx, gy = r.y0 + r.h*fy;
          const anchor = gridToScreen(gx, gy);
          drawables.push({ depth: gx+gy, fn:(ctx)=>drawFurniturePart(ctx, part.part, anchor.x, anchor.y) });
        }
      }
    }

    // player-placed functional furniture (chairs / vending machines / fountains / plants)
    for(const o of this.hospital.objects){
      const anchor = gridToScreen(o.x+0.5, o.y+0.5);
      drawables.push({ depth: o.x+o.y+0.5, fn:(ctx)=>this._drawPlacedObject(ctx, o, anchor.x, anchor.y) });
    }

    // floor messes (untreated GI diseases) - drawn low, just above the floor tile, so
    // characters walking past still occlude it correctly
    for(const m of this.hospital.messes){
      const anchor = gridToScreen(m.x/TILE, m.y/TILE);
      drawables.push({ depth: m.x/TILE+m.y/TILE-0.4, fn:(ctx)=>this._drawMess(ctx, m, anchor.x, anchor.y) });
    }

    // characters
    for(const e of this.patients){
      const gd = e.x/TILE + e.y/TILE;
      drawables.push({ depth: gd, fn:(ctx)=>this._drawPatient(ctx, e) });
    }
    for(const e of this.staff){
      const gd = e.x/TILE + e.y/TILE;
      drawables.push({ depth: gd, fn:(ctx)=>this._drawStaff(ctx, e) });
    }

    // The outer shell (and especially the entrance marker) stays visible even while placing a
    // room or furniture (design feedback: it used to vanish along with the room walls during
    // build mode, making it impossible to see where the entrance is while deciding where to put
    // a new room relative to it). Only the *interior* room walls hide during placement, further
    // up in this function - the boundary is a fixed reference point and should never disappear.
    this._pushBoundaryWalls(drawables);

    return drawables;
  }

  // The hospital's own outer shell, all 4 sides rendered (unlike room walls, which cull their
  // near sides so the camera can see inside) - it's just an exterior shell, nothing to hide
  // behind it. One gap, at the entrance, is where every patient and every delivery comes through.
  // Computes the T-shaped hospital footprint's outer polygon (in grid coordinates, clockwise),
  // for the bold outline drawn in _drawBuildOverlay while the walls themselves are hidden.
  // Explicit per-direction cases, same reasoning as _pushBoundaryWalls's own layout logic.
  _hospitalOutlinePoints(){
    const H = this.hospital, bar = H.bar, stem = H.stem, dir = H.direction;
    if(dir==="down"){
      return [
        {x:bar.x0,y:bar.y0},{x:bar.x1,y:bar.y0},{x:bar.x1,y:bar.y1},
        {x:stem.x1,y:bar.y1},{x:stem.x1,y:stem.y1},{x:stem.x0,y:stem.y1},
        {x:stem.x0,y:bar.y1},{x:bar.x0,y:bar.y1},
      ];
    } else if(dir==="up"){
      return [
        {x:bar.x0,y:bar.y1},{x:bar.x1,y:bar.y1},{x:bar.x1,y:bar.y0},
        {x:stem.x1,y:bar.y0},{x:stem.x1,y:stem.y0},{x:stem.x0,y:stem.y0},
        {x:stem.x0,y:bar.y0},{x:bar.x0,y:bar.y0},
      ];
    } else if(dir==="right"){
      return [
        {x:bar.x0,y:bar.y0},{x:bar.x1,y:bar.y0},{x:bar.x1,y:stem.y0},
        {x:stem.x1,y:stem.y0},{x:stem.x1,y:stem.y1},{x:bar.x1,y:stem.y1},
        {x:bar.x1,y:bar.y1},{x:bar.x0,y:bar.y1},
      ];
    } else { // left
      return [
        {x:bar.x1,y:bar.y0},{x:bar.x0,y:bar.y0},{x:bar.x0,y:stem.y0},
        {x:stem.x0,y:stem.y0},{x:stem.x0,y:stem.y1},{x:bar.x0,y:stem.y1},
        {x:bar.x0,y:bar.y1},{x:bar.x1,y:bar.y1},
      ];
    }
  }
  _pushBoundaryWalls(drawables){
    const color = "#5f5648";
    const H = this.hospital;
    const bar = H.bar, stem = H.stem, ent = H.entrance;
    // Same as individual room walls: hide entirely while placing a room or furniture (design
    // feedback: previously only south/east were hidden, but north/west could still block the
    // view) - a bold outline of the whole building's footprint (see _drawBuildOverlay) replaces
    // every wall while this is active. The door itself is drawn separately below and stays
    // visible either way.
    const hideAll = !!(this.buildMode || this.placeMode);
    // Horizontal wall run (fixed row, spanning x0..x1), tagged with which way it faces so the
    // near-wall hiding above can apply; optionally skips a gap range (the entrance).
    const hRun = (x0,x1,y,facing,gap)=>{
      if(hideAll) return;
      for(let x=x0;x<x1;x++){
        if(gap && x>=gap.x0 && x<gap.x1) continue;
        drawables.push({ depth: x+0.5+y, fn:(ctx)=>wallQuad(ctx,x,y,x+1,y,color,WALL_H_OUTER) });
      }
    };
    // Vertical wall run (fixed column, spanning y0..y1), same idea.
    const vRun = (x,y0,y1,facing,gap)=>{
      if(hideAll) return;
      for(let y=y0;y<y1;y++){
        if(gap && y>=gap.y0 && y<gap.y1) continue;
        drawables.push({ depth: x+y+0.5, fn:(ctx)=>wallQuad(ctx,x,y,x,y+1,color,WALL_H_OUTER) });
      }
    };
    const dir = H.direction;
    const hGap = ent.axis==="h" ? ent : null, vGap = ent.axis==="v" ? ent : null;

    if(dir==="down" || dir==="up"){
      const barFarY = dir==="down" ? bar.y0 : bar.y1;   // the bar's outer edge, away from the stem
      const seamY = dir==="down" ? bar.y1 : bar.y0;      // where bar meets stem
      const stemFarY = dir==="down" ? stem.y1 : stem.y0; // the stem's outer edge (entrance wall)
      const farFacing = dir==="down" ? "N" : "S", seamFacing = dir==="down" ? "S" : "N";
      hRun(bar.x0, bar.x1, barFarY, farFacing);           // bar's outer long wall
      vRun(bar.x0, bar.y0, bar.y1, "W");                   // bar left
      vRun(bar.x1, bar.y0, bar.y1, "E");                   // bar right
      hRun(bar.x0, stem.x0, seamY, seamFacing);             // left shoulder
      hRun(stem.x1, bar.x1, seamY, seamFacing);             // right shoulder
      vRun(stem.x0, stem.y0, stem.y1, "W");                  // stem left
      vRun(stem.x1, stem.y0, stem.y1, "E");                  // stem right
      hRun(stem.x0, stem.x1, stemFarY, farFacing, hGap);      // stem outer wall, with entrance gap
    } else {
      const barFarX = dir==="right" ? bar.x0 : bar.x1;
      const seamX = dir==="right" ? bar.x1 : bar.x0;
      const stemFarX = dir==="right" ? stem.x1 : stem.x0;
      const farFacing = dir==="right" ? "W" : "E", seamFacing = dir==="right" ? "E" : "W";
      vRun(barFarX, bar.y0, bar.y1, farFacing);
      hRun(bar.x0, bar.x1, bar.y0, "N");
      hRun(bar.x0, bar.x1, bar.y1, "S");
      vRun(seamX, bar.y0, stem.y0, seamFacing);
      vRun(seamX, stem.y1, bar.y1, seamFacing);
      hRun(stem.x0, stem.x1, stem.y0, "N");
      hRun(stem.x0, stem.x1, stem.y1, "S");
      vRun(stemFarX, stem.y0, stem.y1, farFacing, vGap);
    }

    // door + small sign, at whichever tile the entrance actually ended up on
    const doorMidX = ent.axis==="h" ? (ent.x0+ent.x1)/2 : ent.x0;
    const doorMidY = ent.axis==="v" ? (ent.y0+ent.y1)/2 : ent.y0;
    if(ent.axis==="h"){
      drawables.push({ depth: doorMidX+ent.y0, fn:(ctx)=>drawDoorOnWall(ctx,ent.x0,ent.y0,ent.x1,ent.y0,WALL_H_OUTER,H._entranceDoorOpenAmount) });
    } else {
      drawables.push({ depth: ent.x0+doorMidY, fn:(ctx)=>drawDoorOnWall(ctx,ent.x0,ent.y0,ent.x0,ent.y1,WALL_H_OUTER,H._entranceDoorOpenAmount) });
    }
    drawables.push({ depth: doorMidX+doorMidY+0.5, fn:(ctx)=>{
      const p = gridToScreen(doorMidX, doorMidY);
      ctx.font="16px sans-serif"; ctx.textAlign="center";
      ctx.fillText("🏥", p.x, p.y-WALL_H_OUTER-4);
    }});
  }

  // Room name plates always render last, above everything else - depth-sorting them with the
  // walls could leave a label half-hidden behind its own wall depending on nearby characters.
  _drawRoomLabels(ctx){
    for(const r of this.hospital.rooms){
      const def = ROOM_TYPES[r.type];
      const labelPos = gridToScreen(r.x0, (r.y0+r.y1)/2);
      ctx.save();
      ctx.translate(labelPos.x, labelPos.y-WALL_H*0.6);
      ctx.rotate(-0.46);
      ctx.fillStyle="rgba(0,0,0,.35)";
      ctx.font="700 9px sans-serif"; ctx.textAlign="center";
      ctx.fillText(def.name, 0.6, 0.6);
      ctx.fillStyle="rgba(255,255,255,.98)";
      ctx.fillText(def.name, 0, 0);
      ctx.restore();
      const role = this._roleForRoom(def);
      if(role){
        const cap = r.staffCapacity!=null ? r.staffCapacity : (def.capacity||0);
        const understaffed = r.staffIds.length===0;
        ctx.save();
        ctx.translate(labelPos.x, labelPos.y-WALL_H*0.6+11);
        ctx.rotate(-0.46);
        ctx.fillStyle = understaffed? "rgba(255,150,130,.95)" : "rgba(255,255,255,.85)";
        ctx.font="700 8px sans-serif"; ctx.textAlign="center";
        ctx.fillText((understaffed?"⚠ ":"")+role.symbol+" "+r.staffIds.length+"/"+cap, 0, 0);
        ctx.restore();
      }
    }
  }

  _drawVendingProp(ctx, kind, x, y){
    ctx.save();
    ctx.translate(x,y);
    ctx.fillStyle="rgba(0,0,0,.15)"; ctx.beginPath(); ctx.ellipse(0,9,7,2.6,0,0,Math.PI*2); ctx.fill();
    if(kind==="fountain"){
      ctx.fillStyle="#b9c2c9"; ctx.fillRect(-6,-3,12,11);
      ctx.fillStyle="#8fa0ad"; ctx.fillRect(-6,-3,12,3);
      ctx.fillStyle="#4f8fb0"; ctx.beginPath(); ctx.arc(0,-4.5,2,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle="#7f8f9a"; ctx.lineWidth=1; ctx.strokeRect(-6,-3,12,11);
    } else {
      ctx.fillStyle="#3a5e5a"; ctx.fillRect(-7,-11,14,17);
      ctx.strokeStyle="#294341"; ctx.lineWidth=1; ctx.strokeRect(-7,-11,14,17);
      ctx.fillStyle="#8fd8cf"; ctx.fillRect(-5,-9,10,9);
      ctx.fillStyle="#e8b13c"; ctx.fillRect(-4,-8,3,2.4);
      ctx.fillStyle="#c0703f"; ctx.fillRect(0.5,-8,3,2.4);
      ctx.fillStyle="#5f9e5a"; ctx.fillRect(-4,-4.5,3,2.4);
      ctx.fillStyle="#e07a3f"; ctx.fillRect(0.5,-4.5,3,2.4);
    }
    ctx.restore();
  }

  // player-placed functional furniture from the Furniture tab
  _drawPlacedObject(ctx, o, x, y){
    if(o.type==="fountain"){ this._drawVendingProp(ctx,"fountain",x,y); return; }
    if(o.type==="vending"){ this._drawVendingProp(ctx,"snacks",x,y); return; }
    ctx.save();
    ctx.translate(x,y);
    if(o.type==="chair"){
      const occupied = !!o.occupiedBy;
      ctx.fillStyle="rgba(0,0,0,.15)"; ctx.beginPath(); ctx.ellipse(0,8,6,2.3,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle= occupied? "#a8734a" : "#8a5a3a"; ctx.fillRect(-5,1,10,4.5);
      ctx.fillStyle="#6b4426"; ctx.fillRect(-5,-7,10,2.6);
      ctx.fillStyle="#5a3a20"; ctx.fillRect(-5,-5,2,10.5); ctx.fillRect(3,-5,2,10.5);
    } else if(o.type==="plant"){
      ctx.fillStyle="rgba(0,0,0,.15)"; ctx.beginPath(); ctx.ellipse(0,8,7,2.4,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle="#a85326"; ctx.beginPath(); ctx.moveTo(-6,8); ctx.lineTo(6,8); ctx.lineTo(4,-1); ctx.lineTo(-4,-1); ctx.closePath(); ctx.fill();
      ctx.fillStyle="#4a8a3f";
      ctx.beginPath(); ctx.ellipse(0,-10,4,7,0,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(-6,-6,3.4,5.6,-0.4,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(6,-6,3.4,5.6,0.4,0,Math.PI*2); ctx.fill();
    } else {
      // Generic fallback for newer furniture (radiator/bin/fire extinguisher, etc.) - a small
      // labelled block using its catalogue symbol, so nothing is invisible on the map before
      // each one gets bespoke pixel art in a later pass.
      const def = OBJECT_TYPES[o.type];
      ctx.fillStyle="rgba(0,0,0,.15)"; ctx.beginPath(); ctx.ellipse(0,8,6,2.2,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle="#dfe6ea"; ctx.strokeStyle="#8fa0ad"; ctx.lineWidth=1.2;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-7,-9,14,16,3) : ctx.rect(-7,-9,14,16);
      ctx.fill(); ctx.stroke();
      ctx.font="700 11px sans-serif"; ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.fillText(def?def.symbol:"❔", 0, -1);
    }
    ctx.restore();
  }

  _drawMess(ctx, m, x, y){
    // A "body" mess is a purely logical marker for the janitor to path to and clean - the
    // deceased patient already renders their own lying-down body + skull (see the patient
    // rendering code), so drawing anything here too would double it up.
    if(m.type==="body") return;
    ctx.save();
    ctx.translate(x, y);
    if(m.type==="poop"){
      ctx.fillStyle="#6b4a2a";
      ctx.beginPath(); ctx.ellipse(0,0,6,3,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle="#4a3320";
      ctx.beginPath(); ctx.ellipse(-1.5,-0.6,2.2,1.4,0,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(2,0.6,1.8,1.2,0,0,Math.PI*2); ctx.fill();
    } else {
      ctx.fillStyle="#8fbf6a";
      ctx.beginPath(); ctx.ellipse(0,0,6.5,3.2,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle="#6f9e52";
      ctx.beginPath(); ctx.ellipse(-2,-0.4,2,1.2,0,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(2.4,0.5,1.6,1,0,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0.2,1.2,1.4,0.9,0,0,Math.PI*2); ctx.fill();
    }
    ctx.restore();
  }

  _bob(e){ return e.moving? Math.sin(e.animT*9)*1.6 : Math.sin(e.animT*2)*0.6; }
  _legPhase(e){ return e.moving? Math.sin(e.animT*9) : 0; }
  _armPhase(e){ return e.moving? Math.sin(e.animT*9+Math.PI) : Math.sin(e.animT*1.6)*0.15; }
  _breathe(e){ return e.moving? 1 : 1+Math.sin(e.animT*1.8+e.idlePhase)*0.018; }
  _sway(e){ return e.moving? 0 : Math.sin(e.animT*0.6+e.idlePhase)*0.05; }

  // deterministic pick from an id string, so each character keeps a stable look
  _pick(id, arr, salt){
    let h=0; const s = id+"_"+(salt||"");
    for(let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i))>>>0;
    return arr[h % arr.length];
  }

  static get SKIN_TONES(){ return ["#f3d2ae","#e8b98c","#c98f65","#a86a43","#8d5a3a","#f6dfc4"]; }
  static get HAIR_COLORS(){ return ["#2b2018","#4a3222","#6b4a2a","#1a1a1a","#7a5a3a","#c9a35a","#3a2a1a"]; }
  static get SHIRT_COLORS(){ return ["#4f8fb0","#c0703f","#7c6fb0","#5f9e5a","#c05f7f","#4a90a4","#d4954a","#6b7fb8"]; }
  static get PANTS_COLORS(){ return ["#33506a","#5a4632","#3a3a4a","#2f4a3a","#4a3550"]; }
  // how much faster practitioners move during the greet/escort/see-out legs of a patient
  // interaction, vs their normal walking speed - keeps the walk visible without eating
  // significantly into how many patients they can actually see per day
  static get ESCORT_SPEED_MULT(){ return 1.25; } // a slightly brisker "let me show you in" pace, not a sprint

  _roundRect(ctx,x,y,w,h,r){
    ctx.beginPath();
    ctx.moveTo(x+r,y);
    ctx.arcTo(x+w,y,x+w,y+h,r);
    ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r);
    ctx.arcTo(x,y,x+w,y,r);
    ctx.closePath();
  }

  // Same rig as the top-down build, with the iso-specific corrections validated in the
  // preview: a fixed scale to read well against 64x32 tiles, a ground-offset shift so the feet
  // (not the rig's internal hip-height origin) land exactly on the tile center, and a gentle
  // breathing/sway when idle. Leg/arm/bob timing intentionally stays per-entity (e.animT) rather
  // than a shared clock, so many characters walking at once don't all swing their legs in lockstep.
  _drawHumanoid(ctx, e, opts){
    const bob = this._bob(e);
    const lp = this._legPhase(e);
    const ap = this._armPhase(e);
    const breathe = this._breathe(e);
    const sway = this._sway(e);
    const scr = gridToScreen(e.x/TILE, e.y/TILE);

    ctx.save();
    ctx.translate(scr.x, scr.y+bob-HUMANOID_GROUND_OFFSET);
    ctx.rotate(sway);
    ctx.scale(1.35*breathe, 1.35);
    if(opts.transparent) ctx.globalAlpha = 0.4; // Transparency disease: whole body faded

    // ground shadow
    ctx.fillStyle="rgba(0,0,0,.2)";
    ctx.beginPath(); ctx.ellipse(0,10.5,7.5,3,0,0,Math.PI*2); ctx.fill();

    // legs (pants + shoe)
    ctx.lineCap="round";
    ctx.strokeStyle = opts.pants; ctx.lineWidth=3.2;
    ctx.beginPath(); ctx.moveTo(-2.2,4); ctx.lineTo(-2.2+lp*3.4,10.5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(2.2,4); ctx.lineTo(2.2-lp*3.4,10.5); ctx.stroke();
    ctx.strokeStyle = "#2a2a2a"; ctx.lineWidth=2.4;
    ctx.beginPath(); ctx.moveTo(-2.2+lp*3.4,10.5); ctx.lineTo(-2.2+lp*3.4,11.6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(2.2-lp*3.4,10.5); ctx.lineTo(2.2-lp*3.4,11.6); ctx.stroke();

    // arms (behind torso), swing opposite the legs
    ctx.strokeStyle = opts.shirt; ctx.lineWidth=2.6;
    ctx.beginPath(); ctx.moveTo(-4.6,-1); ctx.lineTo(-4.6-ap*3,6.5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(4.6,-1); ctx.lineTo(4.6+ap*3,6.5); ctx.stroke();
    ctx.fillStyle = opts.skin;
    ctx.beginPath(); ctx.arc(-4.6-ap*3,7,1.5,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(4.6+ap*3,7,1.5,0,Math.PI*2); ctx.fill();

    // torso with subtle vertical shading
    const grad = ctx.createLinearGradient(-6,-4,6,7);
    grad.addColorStop(0, opts.shirtLight || opts.shirt);
    grad.addColorStop(1, opts.shirt);
    ctx.fillStyle = grad;
    this._roundRect(ctx,-6,-4,12,11,4);
    ctx.fill();
    if(opts.coat){
      ctx.fillStyle = "rgba(255,255,255,.92)";
      this._roundRect(ctx,-6,-4,12,11,4);
      ctx.save(); ctx.clip();
      ctx.fillRect(-6,-4,5.2,11);
      ctx.fillRect(0.8,-4,5.2,11);
      ctx.restore();
      ctx.strokeStyle="rgba(0,0,0,.12)"; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(0,-3); ctx.lineTo(0,6.5); ctx.stroke();
    }
    if(opts.badge){
      ctx.fillStyle = opts.accent;
      ctx.beginPath(); ctx.arc(0,1.5,2.6,0,Math.PI*2); ctx.fill();
      ctx.fillStyle="#fff"; ctx.font="700 3.2px sans-serif"; ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.fillText(opts.badge,0,1.7);
      ctx.textBaseline="alphabetic";
    }

    // neck
    ctx.fillStyle = opts.skin;
    ctx.fillRect(-1.6,-6,3.2,3);

    // head with gentle shading
    const headGrad = ctx.createRadialGradient(-1.5,-9.5,1,0,-8.5,6);
    headGrad.addColorStop(0, opts.skinLight || opts.skin);
    headGrad.addColorStop(1, opts.skin);
    ctx.fillStyle = headGrad;
    ctx.beginPath(); ctx.arc(0,-8.5,5.3,0,Math.PI*2); ctx.fill();

    // ears
    ctx.fillStyle = opts.skin;
    ctx.beginPath(); ctx.arc(-5.1,-8.3,1.1,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(5.1,-8.3,1.1,0,Math.PI*2); ctx.fill();

    // hair
    if(opts.hair!=="none"){
      ctx.fillStyle = opts.hairColor;
      ctx.beginPath();
      ctx.arc(0,-11.2,5.5,Math.PI*0.98,Math.PI*2.02);
      ctx.fill();
      if(opts.hair==="short"){
        ctx.beginPath(); ctx.ellipse(0,-12.6,5.6,3.2,0,Math.PI,Math.PI*2); ctx.fill();
      }
    }
    if(opts.hat){
      ctx.fillStyle = opts.hatColor || opts.accent;
      this._roundRect(ctx,-4.6,-14.2,9.2,3.4,1.5); ctx.fill();
      ctx.fillRect(-5.4,-11.6,10.8,1.6);
    }

    // face
    ctx.fillStyle="#2a2018";
    ctx.beginPath(); ctx.arc(-1.7,-8.6,0.55,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(1.7,-8.6,0.55,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle="rgba(0,0,0,.35)"; ctx.lineWidth=0.6; ctx.lineCap="round";
    ctx.beginPath();
    if(opts.mood==="happy") ctx.arc(0,-6.6,1.3,0.15*Math.PI,0.85*Math.PI);
    else if(opts.mood==="sad") ctx.arc(0,-5.6,1.3,1.15*Math.PI,1.85*Math.PI);
    else ctx.moveTo(-1.1,-6.6), ctx.lineTo(1.1,-6.6);
    ctx.stroke();

    if(opts.transparent){
      // Transparency disease: a faint skeleton showing through the faded torso/head/hands
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = "rgba(235,235,240,.9)"; ctx.fillStyle = "rgba(235,235,240,.9)";
      ctx.lineWidth = 0.9; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(0,-4.5); ctx.lineTo(0,5.5); ctx.stroke(); // spine
      for(let ry=-3; ry<=4; ry+=2.4){ // ribs
        ctx.beginPath(); ctx.moveTo(-3.6,ry); ctx.lineTo(3.6,ry); ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(0,-8.5,2.2,0,Math.PI*2); ctx.stroke(); // skull outline
      ctx.beginPath(); ctx.arc(-1.4,-8.7,0.5,0,Math.PI*2); ctx.fill(); // eye sockets
      ctx.beginPath(); ctx.arc(1.4,-8.7,0.5,0,Math.PI*2); ctx.fill();
    }

    ctx.restore();
    return {bob};
  }

  // Invisibility disease: no body is drawn at all - just the hat, glasses, cane, wristwatch,
  // and shoes, floating in the same arrangement a normal body's rig would occupy.
  _drawInvisiblePatient(ctx, p){
    const bob = this._bob(p);
    const sway = this._sway(p);
    const scr = gridToScreen(p.x/TILE, p.y/TILE);
    const hatColor = this._pick(p.id, Game.SHIRT_COLORS, "shirt");

    ctx.save();
    ctx.translate(scr.x, scr.y+bob-HUMANOID_GROUND_OFFSET);
    ctx.rotate(sway);
    ctx.scale(1.35, 1.35);

    // ground shadow, so it still reads as "standing here" despite the empty air above it
    ctx.fillStyle="rgba(0,0,0,.18)";
    ctx.beginPath(); ctx.ellipse(0,10.5,7,2.6,0,0,Math.PI*2); ctx.fill();

    // shoes
    ctx.fillStyle="#2a2018";
    ctx.beginPath(); ctx.ellipse(-2.2,10.8,2,1.3,0,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(2.2,10.8,2,1.3,0,0,Math.PI*2); ctx.fill();

    // wristwatch, on one hand's position
    ctx.strokeStyle="#8a6a3a"; ctx.lineWidth=1.4;
    ctx.beginPath(); ctx.arc(-4.6,6.8,1.4,0,Math.PI*2); ctx.stroke();
    ctx.fillStyle="#d8cfa0"; ctx.beginPath(); ctx.arc(-4.6,6.8,0.8,0,Math.PI*2); ctx.fill();

    // walking stick, held in the other hand, angled down to the ground
    ctx.strokeStyle="#6b4426"; ctx.lineWidth=1.3; ctx.lineCap="round";
    ctx.beginPath(); ctx.moveTo(4.6,6.5); ctx.lineTo(6.5,11.2); ctx.stroke();
    ctx.beginPath(); ctx.arc(4.3,5.6,1.1,0,Math.PI*1.5); ctx.stroke();

    // glasses, floating at head height
    ctx.strokeStyle="#2a2a2a"; ctx.lineWidth=0.9;
    ctx.beginPath(); ctx.arc(-1.9,-8.6,1.5,0,Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.arc(1.9,-8.6,1.5,0,Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-0.4,-8.6); ctx.lineTo(0.4,-8.6); ctx.stroke();

    // hat, floating above where the head would be
    ctx.fillStyle = hatColor;
    this._roundRect(ctx,-4.6,-14.2,9.2,3.4,1.5); ctx.fill();
    ctx.fillRect(-5.4,-11.6,10.8,1.6);

    ctx.restore();
    return {bob};
  }

  // Small overlay effects for the diseases that "don't visually change the patient" per their
  // description, but benefit from a subtle tell anyway - drawn in the same unscaled, translated
  // space as the state bubble/mood bar above, so coordinates are roughly "head at y=-15, torso
  // at y=-3..5, feet at y=10..12". Kept intentionally light: a mark or two, not a new rig.
  _drawDiseaseEffect(ctx, p){
    const t = p.animT;
    switch(p.diseaseKey){
      case "brokenWind": {
        const phase = (t*0.4)%3;
        if(phase < 1){
          ctx.globalAlpha = 1-phase;
          ctx.font="9px sans-serif"; ctx.textAlign="center";
          ctx.fillText("💨", -7, -2+phase*3);
          ctx.globalAlpha = 1;
        }
        break;
      }
      case "chronicNosehair": {
        ctx.strokeStyle="#2a2018"; ctx.lineWidth=0.8; ctx.lineCap="round";
        ctx.beginPath(); ctx.moveTo(-0.6,-14); ctx.lineTo(-1.1,-11.8); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0.6,-14); ctx.lineTo(1.1,-11.8); ctx.stroke();
        break;
      }
      case "corrugatedAnkles": {
        ctx.strokeStyle="rgba(0,0,0,.4)"; ctx.lineWidth=0.8;
        for(const side of [-1,1]){
          ctx.beginPath();
          ctx.moveTo(side*2,10); ctx.lineTo(side*3,11); ctx.lineTo(side*2,12); ctx.lineTo(side*3,13);
          ctx.stroke();
        }
        break;
      }
      case "discreteItching": {
        const scratch = Math.sin(t*6)*1.6;
        ctx.strokeStyle="rgba(0,0,0,.3)"; ctx.lineWidth=0.9; ctx.lineCap="round";
        ctx.beginPath(); ctx.moveTo(5,-3+scratch*0.4); ctx.lineTo(3,-1+scratch*0.4); ctx.stroke();
        break;
      }
      case "gastricEjections": {
        const phase = (t*0.5)%2.5;
        if(phase<1){
          ctx.globalAlpha = 1-phase;
          ctx.fillStyle="#8fbf6a";
          ctx.beginPath(); ctx.arc(2,-13,1.3,0,Math.PI*2); ctx.fill();
          ctx.globalAlpha = 1;
        }
        break;
      }
      case "gutRot": {
        ctx.fillStyle="rgba(120,170,80,.22)";
        ctx.beginPath(); ctx.ellipse(0,-3,5.5,7,0,0,Math.PI*2); ctx.fill();
        break;
      }
      case "heapedPiles": {
        ctx.strokeStyle="rgba(0,0,0,.3)"; ctx.lineWidth=0.9; ctx.lineCap="round";
        ctx.beginPath(); ctx.moveTo(-4,-1); ctx.lineTo(-1,3); ctx.stroke(); // hand resting on lower back
        break;
      }
      case "sleepingIllness": {
        const phase = (t*0.5)%3;
        ctx.globalAlpha = phase<1.5? 1 : clamp((3-phase)/1.5,0,1);
        ctx.font="9px sans-serif"; ctx.textAlign="center";
        ctx.fillText("💤", 6, -18-Math.min(phase,1.5)*3);
        ctx.globalAlpha = 1;
        break;
      }
      case "theSquits": {
        const phase = (t*0.7)%2;
        if(phase<0.6){
          ctx.globalAlpha = 1-phase/0.6;
          ctx.fillStyle="#7a9e6a";
          ctx.beginPath(); ctx.ellipse(-3,-9,1,1.6,0,0,Math.PI*2); ctx.fill();
          ctx.globalAlpha = 1;
        }
        break;
      }
      case "uncommonCold": {
        ctx.fillStyle="#c05f5f";
        ctx.beginPath(); ctx.arc(0,-13.2,1,0,Math.PI*2); ctx.fill();
        const phase=(t*0.45)%3;
        if(phase<0.5){
          ctx.globalAlpha = 1-phase/0.5;
          ctx.font="8px sans-serif"; ctx.textAlign="center";
          ctx.fillText("🤧", 6,-16);
          ctx.globalAlpha = 1;
        }
        break;
      }
    }
  }

  _drawPatient(ctx, p){
    const skin = this._pick(p.id, Game.SKIN_TONES, "skin");
    const hairColor = this._pick(p.id, Game.HAIR_COLORS, "hair");
    const shirt = this._pick(p.id, Game.SHIRT_COLORS, "shirt");
    const pants = this._pick(p.id, Game.PANTS_COLORS, "pants");

    if(p.state==="dead"){
      const scr = gridToScreen(p.x/TILE, p.y/TILE);
      ctx.save();
      ctx.translate(scr.x, scr.y-2);
      // lying flat: a squashed body silhouette instead of the standing rig
      ctx.fillStyle="rgba(0,0,0,.22)"; ctx.beginPath(); ctx.ellipse(0,3,15,5.5,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle=shirt; ctx.beginPath(); ctx.ellipse(2,2,10,4.6,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle=pants; ctx.beginPath(); ctx.ellipse(-9,2.5,6,3.4,0,0,Math.PI*2); ctx.fill();
      ctx.fillStyle=skin; ctx.beginPath(); ctx.arc(11,1.5,4.4,0,Math.PI*2); ctx.fill();
      ctx.fillStyle=hairColor; ctx.beginPath(); ctx.arc(11,-1.2,3.4,Math.PI,Math.PI*2); ctx.fill();
      // fading-IN skull marker over the first second (settles in place), then stays fully
      // visible indefinitely - the body itself no longer disappears on its own; only the
      // janitor cleaning it up (see the "cleaning" state) removes it now.
      const fadeIn = clamp((p.deadTimer||0)/1, 0, 1);
      ctx.globalAlpha = 0.55+0.45*fadeIn;
      ctx.font="13px sans-serif"; ctx.textAlign="center";
      ctx.fillText("💀", 0, -14-(1-fadeIn)*6);
      ctx.restore();
      return;
    }

    const mood = p.happiness<35? "sad" : p.happiness>70? "happy":"neutral";
    if(p.diseaseKey==="invisibility"){
      this._drawInvisiblePatient(ctx, p);
    } else {
      this._drawHumanoid(ctx, p, {
        skin, skinLight: skin, hairColor, shirt, pants,
        hair: p.age<12? "short":"short", mood, accent:"#333",
        transparent: p.diseaseKey==="transparency"
      });
    }
    const scr = gridToScreen(p.x/TILE, p.y/TILE);
    // Emergency patients pulse with a glowing ring (design feedback: hard to tell which patient
    // an "unhappy patients" or emergency alert is even about) - drawn under the character so it
    // reads as a floor glow rather than obscuring them.
    if(p.isEmergency){
      const pulse = 0.5+0.5*Math.sin(p.animT*4);
      ctx.save();
      ctx.translate(scr.x, scr.y);
      ctx.globalAlpha = 0.35+0.35*pulse;
      ctx.fillStyle = "#e04032";
      ctx.beginPath();
      ctx.ellipse(0, -2, 12+pulse*2, 6+pulse, 0, 0, Math.PI*2);
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    ctx.translate(scr.x, scr.y+this._bob(p)-HUMANOID_GROUND_OFFSET);
    let bubble=null;
    if(p.state==="beingConsulted") bubble="❔";
    else if(p.state==="beingTreated") bubble="💉";
    else if(p.state.startsWith("queue")) bubble="⏳";
    if(p.isEmergency) bubble="🚨"; // takes priority over the state bubble - the emergency status is the more important thing to flag
    if(bubble){ ctx.font="10px sans-serif"; ctx.textAlign="center"; ctx.fillText(bubble, 0, -13); }
    this._drawDiseaseEffect(ctx, p);
    // floating mood bar above patients who are getting upset, so a problem is visible without opening a panel
    if(p.happiness<50){
      const barW=16, barX=-barW/2, barY=-17;
      ctx.fillStyle="rgba(0,0,0,.35)"; ctx.fillRect(barX-1,barY-1,barW+2,4);
      const moodColor = p.happiness<20? "#c0473a" : p.happiness<35? "#e07a3f" : "#e8b13c";
      ctx.fillStyle=moodColor; ctx.fillRect(barX,barY,barW*clamp(p.happiness/100,0,1),2);
    }
    if(p.happiness<30){
      ctx.fillStyle="#c0473a";
      ctx.beginPath(); ctx.arc(6.5,-8,2.2,0,Math.PI*2); ctx.fill();
    }
    ctx.restore();
  }

  _drawStaff(ctx, s){
    const skin = this._pick(s.id, Game.SKIN_TONES, "skin");
    const hairColor = this._pick(s.id, Game.HAIR_COLORS, "hair");
    const pants = "#33404a";
    const opts = { skin, skinLight:skin, hairColor, pants, accent:s.def.accent, mood: s.energy<25? "sad":"neutral", hair:"short" };
    if(s.type==="doctor"){ opts.shirt="#e9edf0"; opts.shirtLight="#ffffff"; opts.coat=true; opts.badge="⚕"; }
    else if(s.type==="nurse"){ opts.shirt="#f2e2e8"; opts.shirtLight="#ffffff"; opts.hat=true; opts.hatColor="#fff"; opts.badge="✚"; }
    else if(s.type==="receptionist"){ opts.shirt="#7c6fb0"; opts.badge="☎"; }
    else if(s.type==="researcher"){ opts.shirt="#e9edf0"; opts.shirtLight="#ffffff"; opts.coat=true; opts.badge="🔬"; }
    else { opts.shirt="#e6b23c"; opts.hat=true; opts.hatColor="#c98f2a"; opts.badge="🔧"; }

    this._drawHumanoid(ctx, s, opts);

    const scr = gridToScreen(s.x/TILE, s.y/TILE);
    ctx.save();
    ctx.translate(scr.x, scr.y+this._bob(s)-HUMANOID_GROUND_OFFSET);
    const isResearching = s.type==="researcher" && s.state==="idle" && s.atSlot;
    ctx.font="10px sans-serif"; ctx.textAlign="center";
    if(s.state==="resting"){ ctx.fillText("💤", 8, -11); }
    else if(s.state==="working" || isResearching){ ctx.fillText("⚙", 8, -11); }
    if(s.energy<25){
      ctx.fillStyle="#c0473a";
      ctx.beginPath(); ctx.arc(-7.5,-9,2.1,0,Math.PI*2); ctx.fill();
    }
    ctx.restore();
  }

  _drawBuildOverlay(ctx){
    if(!this.buildMode || !this.buildDrag) return;
    const bd = this.buildDrag;
    const x0=Math.min(bd.sx,bd.cx), x1=Math.max(bd.sx,bd.cx);
    const y0=Math.min(bd.sy,bd.cy), y1=Math.max(bd.sy,bd.cy);
    const w = x1-x0+1, h = y1-y0+1;
    const check = this.hospital.canPlaceRoom(this.buildMode.type, x0,y0,w,h);
    const fillColor = check.ok? "rgba(95,158,90,.4)":"rgba(192,71,58,.4)";
    const strokeColor = check.ok? "#5f9e5a":"#c0473a";
    for(let gy=y0; gy<=y1; gy++){
      for(let gx=x0; gx<=x1; gx++){
        const p = gridToScreen(gx,gy);
        ctx.beginPath();
        ctx.moveTo(p.x,p.y); ctx.lineTo(p.x+TW/2,p.y+TH/2); ctx.lineTo(p.x,p.y+TH); ctx.lineTo(p.x-TW/2,p.y+TH/2);
        ctx.closePath();
        ctx.fillStyle = fillColor; ctx.fill();
        ctx.strokeStyle = strokeColor; ctx.lineWidth=1.5; ctx.stroke();
      }
    }
  }

  /* ---------------- HUD refresh ---------------- */
  refreshHUD(){
    document.getElementById("hMoney").textContent = fmtMoney(this.economy.money);
    document.getElementById("hPatients").textContent = this.patients.filter(p=>p.state!=="dead").length;
    document.getElementById("hHealth").textContent = this.avgHealth();
    // Morale colorbar (design feedback: replaces the reputation chip to save header space) -
    // the cursor slides left (👎, red) to right (👍, green) along the track based on average
    // patient mood.
    const moraleCursor = document.getElementById("moraleCursor");
    if(moraleCursor) moraleCursor.style.left = clamp(this.avgHappiness(), 0, 100)+"%";
    document.getElementById("hDay").textContent = this.day;
    if(document.getElementById("panelStatsChart").classList.contains("show") && this._openChartMetric){
      this._openStatsChart(this._openChartMetric);
    }
    document.getElementById("cancelModeBtn").classList.toggle("show", !!this.buildMode || !!this.placeMode);
    this._refreshOpenPanels();
  }

  // Every panel that shows live game data re-renders itself on the same tick as the HUD,
  // instead of only when first opened - room/staff/patient details, Manage, Research, Alerts,
  // Objectives all stay current while visible, no need to close and reopen to see a change.
  _refreshOpenPanels(){
    if(document.getElementById("panelSelection").classList.contains("show") && this.selected){
      const kind = this.selected.kind;
      const id = this.selected.entity.id;
      if(kind==="room"){
        const r = this.hospital.rooms.find(x=>x.id===id);
        if(r) this._openRoomInfo(r, true);
        else document.getElementById("panelSelection").classList.remove("show");
      } else if(kind==="staff"){
        const s = this.staff.find(x=>x.id===id);
        if(s) this._openSelection({kind:"staff", entity:s}, true);
        else document.getElementById("panelSelection").classList.remove("show");
      } else if(kind==="patient"){
        const p = this.patients.find(x=>x.id===id);
        if(p && p.state!=="gone") this._openSelection({kind:"patient", entity:p}, true);
        else document.getElementById("panelSelection").classList.remove("show");
      }
    }
    if(document.getElementById("panelManage").classList.contains("show")) this._refreshManagePanel();
    if(document.getElementById("panelResearchTree").classList.contains("show")) this._refreshResearchPanel();
    if(document.getElementById("panelAlerts").classList.contains("show")) this._refreshAlertsPanel();
    if(document.getElementById("panelObjectives").classList.contains("show")) this._refreshObjectives();
    if(document.getElementById("panelPolicy").classList.contains("show")) this._refreshPolicyPanel();
    if(document.getElementById("panelDirectory").classList.contains("show")) this._refreshDirectoryActivePane();
    if(document.getElementById("panelRoomTree").classList.contains("show")) this._renderRoomTree();
    if(document.getElementById("panelHistory").classList.contains("show") && this._historyOpenFor){
      this._openHistory(this._historyOpenFor, this._historyOpenFor.name);
    }
  }

  _refreshPolicyPanel(){
    document.getElementById("polDiagSlider").value = this.policy.diagnosisTermination;
    document.getElementById("polDiagVal").textContent = this.policy.diagnosisTermination+"%";
    document.getElementById("polRestSlider").value = this.policy.staffRestThreshold;
    document.getElementById("polRestVal").textContent = this.policy.staffRestThreshold+"%";
    document.getElementById("polLeaveToggle").classList.toggle("on", this.policy.staffLeaveRooms);
  }

  /* ---------------- main loop ---------------- */
  loop(ts){
    if(!this.lastTs) this.lastTs = ts;
    let dt = (ts - this.lastTs)/1000;
    dt = Math.min(dt, 0.1);
    this.lastTs = ts;
    this.update(dt);
    this.render();
    this._hudTimer = (this._hudTimer||0) + dt;
    if(this._hudTimer>0.2){ this.refreshHUD(); this._hudTimer=0; }
    requestAnimationFrame(this.loop.bind(this));
  }
  start(){
    requestAnimationFrame(this.loop.bind(this));
  }
}

/* =========================================================================
   9. BOOTSTRAP
   ========================================================================= */
window.DPR = Math.min(window.devicePixelRatio||1, DPR_CAP);
document.querySelectorAll("#versionLabel").forEach(el=>el.textContent="v"+GAME_VERSION);
const startVersionEl = document.getElementById("startScreenVersion");
if(startVersionEl) startVersionEl.textContent = "v"+GAME_VERSION;
const game = new Game();
game.start();

})();
