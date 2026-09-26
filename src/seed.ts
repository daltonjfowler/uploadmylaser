// Each material has three presets matching the colour rule students draw with:
//   black = cut (through), red = score ("Mark" in the UI), blue = engrave.
// The only preset for now: the teacher's tested LightBurn settings for Masonite/Luan (2026-09-23).
// Add more materials from the teacher page after test-firing them.
import type { MachineConfig, Material } from '../shared/contracts.ts';

export const DEFAULT_MACHINE: MachineConfig = {
  bedWidthMm: 914,   // LS-3655: 36" x 24". Confirm in docs/HARDWARE.md
  bedHeightMm: 609,
  origin: 'top-right',
  jobOriginMode: 'relative', // teacher's preference: job's top-right corner starts at the laser head
  swizzleMagic: 0x88, // RDC6445S, verified from LightBurn .rd files
  baud: 115200,       // FT245 FIFO; baud is reportedly ignored
  maxJobMinutes: 20,
  absoluteMaxPowerPct: 80,
  minSpeedMmS: 3,
  travelSpeedMmS: 300,
  sendToPanel: false, // off until tested on the real laser (docs/HARDWARE.md, Send to panel)
};

export const SEED_MATERIALS: Material[] = [
  {
    id: 'masonite-luan', name: 'Masonite / Luan', thicknessMm: 3.2, enabled: true,
    ops: {
      cut: { speedMmS: 20, powerMinPct: 55, powerMaxPct: 55, passes: 2 },
      score: { speedMmS: 75, powerMinPct: 20, powerMaxPct: 20, passes: 1 },
      engrave: { speedMmS: 200, powerMinPct: 15, powerMaxPct: 15, passes: 1, hatchMm: 0.1, studentMinPct: 15, studentMaxPct: 35 },
    },
  },
];

// Refused by the teacher API. They give off toxic/corrosive fumes or catch fire.
export const BANNED_MATERIAL_WORDS = ['pvc', 'vinyl', 'polycarbonate', 'lexan', 'abs', 'fiberglass', 'hdpe', 'coated'];
