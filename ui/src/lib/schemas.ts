import { z } from "zod";
import type { Health, Project, Session } from "./types";

/**
 * Contratos mínimos de las respuestas que más usa la UI. Deliberadamente
 * tolerantes con campos nuevos del API (`passthrough`) pero estrictos con la
 * forma que la consola necesita para no romperse en silencio.
 */

const modelRef = z
  .object({
    id: z.string(),
    providerID: z.string(),
    variant: z.string().optional(),
  })
  .passthrough();

const sessionSchema = z
  .object({
    id: z.string(),
    projectID: z.string().optional(),
    agent: z.string().optional(),
    model: modelRef.optional(),
    cost: z.number().optional(),
    tokens: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        reasoning: z.number().optional(),
        cache: z
          .object({ read: z.number().optional(), write: z.number().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    time: z
      .object({
        created: z.number(),
        updated: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

const projectSchema = z
  .object({
    id: z.string(),
    canonical: z.string(),
  })
  .passthrough();

export const sessionSchemaContract = sessionSchema;
export const projectSchemaContract = projectSchema;

export const sessionListSchema = z
  .object({ data: z.array(sessionSchema) })
  .passthrough()
  .transform((value) => value as unknown as { data: Session[] });

export const projectListSchema = z
  .object({ data: z.array(projectSchema) })
  .passthrough()
  .transform((value) => value as unknown as { data: Project[] });

export const healthSchema = z
  .object({
    ok: z.boolean(),
    project_id: z.string(),
    checked_at: z.string(),
    models: z.number(),
    agents: z.number(),
    profiles: z.number(),
  })
  .passthrough()
  .transform((value) => value as unknown as Health);
