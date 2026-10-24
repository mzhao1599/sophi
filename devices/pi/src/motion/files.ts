import { chmodSync, copyFileSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ArmCalibrationSchema,
  LiftConfigSchema,
  LiftInstallationSchema,
  MOTION_CONTRACT_VERSION,
  NamedPoseSchema,
  SkillIdSchema,
  SkillSchema,
  type ArmCalibration,
  type ArmRole,
  type ArmSide,
  type LiftConfig,
  type LiftInstallation,
  type NamedPose,
  type Skill,
} from "@walker/contracts";
import { z } from "zod";
import type { Logger } from "../log";

/**
 * The arm files the Pi keeps in its state folder (`<state>/motion/`, 0700; files 0600):
 * - `calibration-<side>-<role>.json`: one `ArmCalibrationSchema` file per arm, as the contract defines it.
 * - `poses.json`: the named follower poses, each a `NamedPoseSchema`.
 * - `lift.json`: the lift, when one is fitted (`LiftFileSchema`): its motion configuration (the contract's
 *   LiftConfigSchema, which must match the one built into the lift board) and the installer's safety record
 *   (LiftInstallationSchema: guards, drop test, brake). Written by hand by the installer; the Pi only reads it.
 *   No file: no lift on this walker. A file that doesn't parse: no lift either (logged), so lift motion is refused.
 * - `skills/<skill_id>.json` (folder 0700): one taught movement per file, each a contract `SkillSchema` whose
 *   `skill_id` is the file's name. Written atomically. An old one is renamed aside (`.replaced-<time>`,
 *   `.removed-<time>`), never deleted.
 *
 * Why not one `MotionSetupSchema` file: that schema needs every calibrated follower to have a `stowed` pose,
 * and a pose can only be taught after calibration, so a fresh walker could never save its first calibration.
 * The pieces are kept apart and checked with the contract's own schemas instead.
 *
 * A file that doesn't parse is treated as missing (the arm counts as not calibrated) and logged; it is never
 * repaired or guessed at. These files hold no secrets and no one's words.
 */
export const PosesFileSchema = z.strictObject({
  format: z.literal("sophi.poses"),
  version: z.literal(MOTION_CONTRACT_VERSION),
  poses: z.array(NamedPoseSchema).max(64),
});

/** `lift.json`: the motion setup's `lift` (motion.ts MotionSetupSchema), in its own file. */
export const LiftFileSchema = z.strictObject({
  format: z.literal("sophi.lift"),
  version: z.literal(MOTION_CONTRACT_VERSION),
  config: LiftConfigSchema,
  installation: LiftInstallationSchema,
});
export interface LiftSetup {
  config: LiftConfig;
  installation: LiftInstallation;
}
/** What reading `lift.json` found: none (no lift fitted), one that doesn't parse (and why), or the setup. */
export type LiftLoad = { kind: "missing" } | { kind: "invalid"; reason: string } | { kind: "ok"; setup: LiftSetup };

/** What reading one skill file found: none, one that fails the contract's schema (and why), or a valid skill. */
export type SkillLoad = { kind: "missing" } | { kind: "invalid"; reason: string } | { kind: "ok"; skill: Skill };

export class MotionFiles {
  readonly dir: string;
  readonly skillsDir: string;

  constructor(
    stateDir: string,
    private readonly log: Logger,
  ) {
    this.dir = join(stateDir, "motion");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    this.skillsDir = join(this.dir, "skills");
    mkdirSync(this.skillsDir, { recursive: true, mode: 0o700 });
    chmodSync(this.skillsDir, 0o700);
  }

  skillPath(skillId: string): string {
    if (!SkillIdSchema.safeParse(skillId).success) throw new Error("not a skill id");
    return join(this.skillsDir, `${skillId}.json`);
  }

  /** One skill file, checked with the contract's SkillSchema; its `skill_id` must be its file name. */
  readSkill(skillId: string): SkillLoad {
    if (!SkillIdSchema.safeParse(skillId).success) return { kind: "missing" };
    const raw = this.readJson(this.skillPath(skillId));
    if (raw === undefined) return { kind: "missing" };
    if (raw === null) return { kind: "invalid", reason: "the file isn't JSON" };
    const parsed = SkillSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { kind: "invalid", reason: `${issue?.path.join(".") || "file"}: ${issue?.message ?? "invalid"}` };
    }
    if (parsed.data.skill_id !== skillId) return { kind: "invalid", reason: `its skill_id is ${parsed.data.skill_id}, not its file name` };
    return { kind: "ok", skill: parsed.data };
  }

  /** The ids of every skill file (`<id>.json` with a valid id), sorted. */
  listSkillIds(): string[] {
    return readdirSync(this.skillsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((id) => SkillIdSchema.safeParse(id).success)
      .sort();
  }

  skillExists(skillId: string): boolean {
    return this.readSkill(skillId).kind !== "missing";
  }

  /**
   * Saves a skill (checked with SkillSchema first), atomically: written to a temporary file, then put in
   * place. Without `replace` an existing file is never overwritten: the new one is hard-linked into place,
   * which fails (EEXIST) if a file is there. With `replace` the old one is renamed aside first. Returns where
   * the old file went, or null.
   */
  writeSkill(skill: Skill, options: { replace: boolean; stamp: string }): string | null {
    const valid = SkillSchema.parse(skill);
    const path = this.skillPath(valid.skill_id);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${skillJson(valid)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    try {
      if (!options.replace) {
        linkSync(temp, path);
        return null;
      }
      const aside = this.setAside(path, "replaced", options.stamp);
      renameSync(temp, path);
      return aside;
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        // Already renamed into place.
      }
    }
  }

  /** Renames a skill file aside (`.removed-<time>`, kept). Where it went, or null when there was none. */
  removeSkill(skillId: string, stamp: string): string | null {
    return this.setAside(this.skillPath(skillId), "removed", stamp);
  }

  private setAside(path: string, why: "replaced" | "removed", stamp: string): string | null {
    const aside = `${path}.${why}-${stamp.replace(/[^0-9A-Za-z]/g, "")}`;
    try {
      renameSync(path, aside);
      return aside;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return null;
    }
  }

  calibrationPath(side: ArmSide, role: ArmRole): string {
    return join(this.dir, `calibration-${side}-${role}.json`);
  }

  readCalibration(side: ArmSide, role: ArmRole): ArmCalibration | null {
    const raw = this.readJson(this.calibrationPath(side, role));
    if (raw === undefined) return null;
    const parsed = ArmCalibrationSchema.safeParse(raw);
    if (!parsed.success || parsed.data.arm !== side || parsed.data.role !== role) {
      this.log.error("calibration file doesn't match the contract; that arm counts as not calibrated", { arm: side, role });
      return null;
    }
    return parsed.data;
  }

  writeCalibration(calibration: ArmCalibration): void {
    const valid = ArmCalibrationSchema.parse(calibration);
    this.writeAtomic(this.calibrationPath(valid.arm, valid.role), JSON.stringify(valid, null, 2));
  }

  /** Moves an old calibration aside (never deletes it), once the servos' offsets no longer match it. Its new path, or null. */
  retireCalibration(side: ArmSide, role: ArmRole, stamp: string): string | null {
    const path = this.calibrationPath(side, role);
    const aside = `${path}.replaced-${stamp.replace(/[^0-9A-Za-z]/g, "")}`;
    try {
      renameSync(path, aside);
      return aside;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return null;
    }
  }

  /** Puts a calibration set aside by retireCalibration back (a calibration that didn't finish). */
  restoreCalibration(aside: string, side: ArmSide, role: ArmRole): void {
    renameSync(aside, this.calibrationPath(side, role));
  }

  /** Copies the poses file aside (never deleted), before an arm's poses are dropped after a recalibration. */
  backupPoses(stamp: string): string | null {
    const backup = join(this.dir, `poses.json.replaced-${stamp.replace(/[^0-9A-Za-z]/g, "")}`);
    try {
      copyFileSync(join(this.dir, "poses.json"), backup);
      return backup;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return null;
    }
  }

  /** Puts a poses backup back (the copy is kept). */
  restorePoses(backup: string): void {
    copyFileSync(backup, join(this.dir, "poses.json"));
  }

  liftPath(): string {
    return join(this.dir, "lift.json");
  }

  /** The lift's configuration and installation record: none (no file: no lift fitted), malformed (logged), or the setup. */
  readLift(): LiftLoad {
    const raw = this.readJson(this.liftPath());
    if (raw === undefined) return { kind: "missing" };
    if (raw === null) {
      this.log.error("lift file isn't JSON; the lift is off");
      return { kind: "invalid", reason: "lift.json is malformed: it isn't JSON" };
    }
    const parsed = LiftFileSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const problem = `${issue?.path.join(".") || "file"}: ${issue?.message ?? "invalid"}`;
      this.log.error("lift file doesn't match the contract; the lift is off", { problem });
      return { kind: "invalid", reason: `lift.json is malformed (${problem})` };
    }
    return { kind: "ok", setup: { config: parsed.data.config, installation: parsed.data.installation } };
  }

  /** Writes `lift.json` (the simulator and tests; on a walker the installer writes it). */
  writeLift(setup: LiftSetup): void {
    const valid = LiftFileSchema.parse({ format: "sophi.lift", version: MOTION_CONTRACT_VERSION, ...setup });
    this.writeAtomic(this.liftPath(), JSON.stringify(valid, null, 2));
  }

  readPoses(): NamedPose[] {
    const raw = this.readJson(join(this.dir, "poses.json"));
    if (raw === undefined) return [];
    const parsed = PosesFileSchema.safeParse(raw);
    if (!parsed.success) {
      this.log.error("poses file doesn't match the contract; no poses are known");
      return [];
    }
    return parsed.data.poses;
  }

  writePoses(poses: NamedPose[]): void {
    const valid = PosesFileSchema.parse({ format: "sophi.poses", version: MOTION_CONTRACT_VERSION, poses });
    this.writeAtomic(join(this.dir, "poses.json"), JSON.stringify(valid, null, 2));
  }

  private readJson(path: string): unknown {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.log.error("motion file can't be read", { file: path, code: (error as NodeJS.ErrnoException).code });
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private writeAtomic(path: string, contents: string): void {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${contents}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  }
}

/** A skill as JSON for people to read: one field per line, and each of its (thousands of) waypoints on one line. */
export function skillJson(skill: Skill): string {
  const marker = "waypoints go here";
  const text = JSON.stringify({ ...skill, waypoints: marker }, null, 2);
  const waypoints = `[\n${skill.waypoints.map((wp) => `    ${JSON.stringify(wp)}`).join(",\n")}\n  ]`;
  return text.replace(JSON.stringify(marker), () => waypoints);
}
