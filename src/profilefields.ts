// The typed-field schema the page's profile editor renders
// (`GET profiles/fields?kind=`). Keys are Orca setting names; `per_extruder`
// keys are string lists on disk. Pure.

import { ProfileKind } from "./profiles";

export interface FieldOption {
  value: string;
  label: string;
}

export interface ProfileField {
  key: string;
  label: string;
  group: string;
  type: "int" | "float" | "percent" | "bool" | "enum";
  unit?: string;
  min?: number;
  max?: number;
  per_extruder?: boolean;
  options?: FieldOption[];
}

const opts = (pairs: Array<[string, string]>): FieldOption[] => pairs.map(([value, label]) => ({ value, label }));

const temp = (key: string, label: string, group: string, min: number, max: number): ProfileField => ({
  key,
  label,
  group,
  type: "int",
  unit: "°C",
  min,
  max,
  per_extruder: true,
});

const PLATES: Array<[string, string]> = [
  ["cool_plate_temp", "Cool Plate"],
  ["eng_plate_temp", "Engineering Plate"],
  ["hot_plate_temp", "High Temp Plate"],
  ["textured_plate_temp", "Textured PEI Plate"],
];

const FILAMENT: ProfileField[] = [
  temp("nozzle_temperature_initial_layer", "Nozzle (first layer)", "Temperatures", 150, 350),
  temp("nozzle_temperature", "Nozzle (other layers)", "Temperatures", 150, 350),
  ...PLATES.flatMap(([k, plate]) => [
    temp(`${k}_initial_layer`, `${plate} bed (first layer)`, "Bed temperature", 0, 120),
    temp(k, `${plate} bed (other layers)`, "Bed temperature", 0, 120),
  ]),
  { key: "fan_min_speed", label: "Fan min", group: "Cooling", type: "int", unit: "%", min: 0, max: 100, per_extruder: true },
  { key: "fan_max_speed", label: "Fan max", group: "Cooling", type: "int", unit: "%", min: 0, max: 100, per_extruder: true },
  { key: "filament_flow_ratio", label: "Flow ratio", group: "Filament", type: "float", min: 0.5, max: 1.5, per_extruder: true },
  {
    key: "filament_max_volumetric_speed",
    label: "Max volumetric speed",
    group: "Filament",
    type: "float",
    unit: "mm³/s",
    min: 0,
    max: 100,
    per_extruder: true,
  },
];

const PROCESS: ProfileField[] = [
  { key: "layer_height", label: "Layer height", group: "Quality", type: "float", unit: "mm", min: 0.04, max: 1 },
  { key: "wall_loops", label: "Wall loops", group: "Strength", type: "int", min: 0, max: 50 },
  { key: "top_shell_layers", label: "Top shell layers", group: "Strength", type: "int", min: 0, max: 50 },
  { key: "bottom_shell_layers", label: "Bottom shell layers", group: "Strength", type: "int", min: 0, max: 50 },
  { key: "sparse_infill_density", label: "Infill density", group: "Infill", type: "percent", min: 0, max: 100 },
  {
    key: "sparse_infill_pattern",
    label: "Infill pattern",
    group: "Infill",
    type: "enum",
    options: opts([
      ["grid", "Grid"],
      ["rectilinear", "Rectilinear"],
      ["alignedrectilinear", "Aligned rectilinear"],
      ["line", "Line"],
      ["triangles", "Triangles"],
      ["tri-hexagon", "Tri-hexagon"],
      ["cubic", "Cubic"],
      ["adaptivecubic", "Adaptive cubic"],
      ["quartercubic", "Quarter cubic"],
      ["supportcubic", "Support cubic"],
      ["lightning", "Lightning"],
      ["honeycomb", "Honeycomb"],
      ["3dhoneycomb", "3D honeycomb"],
      ["gyroid", "Gyroid"],
      ["concentric", "Concentric"],
      ["hilbertcurve", "Hilbert curve"],
      ["archimedeanchords", "Archimedean chords"],
      ["octagramspiral", "Octagram spiral"],
      ["crosshatch", "Cross hatch"],
      ["zigzag", "Zig zag"],
    ]),
  },
  {
    key: "brim_type",
    label: "Brim",
    group: "Adhesion",
    type: "enum",
    options: opts([
      ["auto_brim", "Auto"],
      ["brim_ears", "Mouse ear"],
      ["outer_only", "Outer brim only"],
      ["inner_only", "Inner brim only"],
      ["outer_and_inner", "Outer and inner brim"],
      ["no_brim", "No brim"],
    ]),
  },
  { key: "brim_width", label: "Brim width", group: "Adhesion", type: "float", unit: "mm", min: 0, max: 50 },
  { key: "enable_support", label: "Supports", group: "Support", type: "bool" },
  {
    key: "support_type",
    label: "Support type",
    group: "Support",
    type: "enum",
    options: opts([
      ["normal(auto)", "Normal (auto)"],
      ["tree(auto)", "Tree (auto)"],
      ["normal(manual)", "Normal (manual)"],
      ["tree(manual)", "Tree (manual)"],
    ]),
  },
  { key: "outer_wall_speed", label: "Outer wall speed", group: "Speed", type: "float", unit: "mm/s", min: 1, max: 1000 },
  { key: "inner_wall_speed", label: "Inner wall speed", group: "Speed", type: "float", unit: "mm/s", min: 1, max: 1000 },
  { key: "sparse_infill_speed", label: "Infill speed", group: "Speed", type: "float", unit: "mm/s", min: 1, max: 1000 },
  { key: "travel_speed", label: "Travel speed", group: "Speed", type: "float", unit: "mm/s", min: 1, max: 1500 },
];

const MACHINE: ProfileField[] = [
  { key: "nozzle_diameter", label: "Nozzle diameter", group: "Extruder", type: "float", unit: "mm", min: 0.1, max: 2, per_extruder: true },
  { key: "retraction_length", label: "Retraction length", group: "Extruder", type: "float", unit: "mm", min: 0, max: 20, per_extruder: true },
  { key: "retraction_speed", label: "Retraction speed", group: "Extruder", type: "float", unit: "mm/s", min: 1, max: 200, per_extruder: true },
  { key: "printable_height", label: "Printable height", group: "Machine", type: "float", unit: "mm", min: 1, max: 2000 },
];

export function profileFields(kind: ProfileKind): ProfileField[] {
  return kind === "filament" ? FILAMENT : kind === "process" ? PROCESS : MACHINE;
}
