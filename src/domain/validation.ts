import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { CHECK_NAMES, type HarnessConfig, type ManagedManifest, type WorkRecord } from "./types.js";

type SchemaName = "config" | "manifest" | "review" | "work";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function validDateTime(value: string): boolean {
  const match = DATE_TIME_PATTERN.exec(value);
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth[month - 1]!
    && hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 23 && offsetMinute <= 59;
}

const ajv = new Ajv2020({ $data: true, allErrors: true, strict: true });
ajv.addFormat("date-time", { type: "string", validate: validDateTime });

function loadSchema(name: SchemaName): AnySchema {
  const url = new URL(`../../assets/schemas/${name}.schema.json`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as AnySchema;
}

const compiled = new Map<SchemaName, ValidateFunction>();

/** Schemas compile on first use, so commands that never validate do not pay for them. */
function validator(name: SchemaName): ValidateFunction {
  let found = compiled.get(name);
  if (!found) {
    found = ajv.compile(loadSchema(name));
    compiled.set(name, found);
  }
  return found;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
}

export function validationDetails(name: SchemaName, value: unknown): ValidationResult {
  const validate = validator(name);
  const valid = validate(value);
  return { valid, errors: valid ? [] : formatErrors(validate.errors) };
}

export function validateConfig(value: unknown): value is HarnessConfig {
  if (!validationDetails("config", value).valid) return false;
  const config = value as HarnessConfig;
  const commands = CHECK_NAMES.map((name) => config.commands?.[name]).filter((command): command is string[] => command !== undefined);
  return commands.every((command) => command.every((part) => !part.includes("\0")));
}

export function validateManifest(value: unknown): value is ManagedManifest {
  return validationDetails("manifest", value).valid;
}

export function validateWorkRecord(value: unknown): value is WorkRecord {
  return validationDetails("work", value).valid;
}
