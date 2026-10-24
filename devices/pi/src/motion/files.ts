import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ArmCalibrationSchema,
  MOTION_CONTRACT_VERSION,
  NamedPoseSchema,
  type ArmCalibration,
  type ArmRole,
  type ArmSide,
  type NamedPose,
} from "@walker/contracts";
import { z } from "zod";
import type { Logger } from "../log";

/**
 * The arm files the Pi keeps in its state folder (`<state>/motion/`, 0700; files 0600):
 * - `calibration-<side>-<role>.json`: one `ArmCalibrationSchema` file per arm, as the contract defines it.
 * - `poses.json`: the named follower poses, each a `NamedPoseSchema`.
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

export class MotionFiles {
  readonly dir: string;

  constructor(
    stateDir: string,
    private readonly log: Logger,
  ) {
    this.dir = join(stateDir, "motion");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
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
