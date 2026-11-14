import { Rpc } from "@opencode/plugin/rpc";

const anyObject = { type: "object", additionalProperties: true } as const;

export const FactoryRpc = Rpc.define({
  id: "opencode.factory",
  methods: {
    health: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: anyObject,
    },
    "models.list": {
      input: {
        type: "object",
        properties: {
          provider_id: { type: "string" },
          family: { type: "string" },
          status: { type: "string" },
          authorized: { type: "boolean" },
          prohibited: { type: "boolean" },
          enabled: { type: "boolean" },
          search: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 2000 },
        },
        additionalProperties: false,
      },
      output: anyObject,
    },
    "models.sync": {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: anyObject,
    },
    "agents.list": {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: anyObject,
    },
    "profiles.list": {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: anyObject,
    },
    "profiles.get": {
      input: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      output: anyObject,
    },
    "profiles.validate": {
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          mode: { type: "string", enum: ["auto", "manual", "hybrid"] },
          is_default: { type: "boolean" },
          policy: { type: "object", additionalProperties: true },
          assignments: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        required: ["name", "assignments"],
        additionalProperties: false,
      },
      output: anyObject,
    },
    "profiles.upsert": {
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          mode: { type: "string", enum: ["auto", "manual", "hybrid"] },
          is_default: { type: "boolean" },
          policy: { type: "object", additionalProperties: true },
          assignments: { type: "array", items: { type: "object", additionalProperties: true } },
        },
        required: ["name", "assignments"],
        additionalProperties: false,
      },
      output: anyObject,
    },
    "profiles.apply": {
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          confirmed: { type: "boolean" },
          make_default: { type: "boolean" },
          session_id: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      output: anyObject,
    },
    "profiles.delete": {
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          confirmed: { type: "boolean" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      output: anyObject,
    },
    "work.overview": {
      input: {
        type: "object",
        properties: { project_id: { type: "string" } },
        additionalProperties: false,
      },
      output: anyObject,
    },
    "work.tasks": {
      input: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          status: { type: "string" },
          search: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      output: anyObject,
    },
    "work.plans": {
      input: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      output: anyObject,
    },
    "work.plan": {
      input: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          plan_id: { type: "string" },
        },
        required: ["plan_id"],
        additionalProperties: false,
      },
      output: anyObject,
    },
    "work.gates": {
      input: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      output: anyObject,
    },
    "work.reviews": {
      input: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      output: anyObject,
    },
    "memory.upsert": {
      input: {
        type: "object",
        properties: {
          entity_key: { type: "string" },
          scope: { type: "string", enum: ["global", "project"] },
          kind: { type: "string", enum: ["preference", "fact", "decision", "convention", "snippet"] },
          title: { type: "string" },
          sections: { type: "object", additionalProperties: { type: "string" } },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          importance: { type: "integer", minimum: 1, maximum: 5 },
          pinned: { type: "boolean" },
          related: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
          last_verified_at: { type: "string" },
        },
        required: ["entity_key"],
        additionalProperties: false,
      },
      output: anyObject,
    },
    "memory.backup": {
      input: {
        type: "object",
        properties: {
          label: { type: "string" },
          ids: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      output: anyObject,
    },
    "memory.consolidation.plan": {
      input: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
          search: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      output: anyObject,
    },
    "memory.consolidation.apply": {
      input: {
        type: "object",
        properties: {
          plan: { type: "object", additionalProperties: true },
          confirmed: { type: "boolean" },
          approve_low_confidence: { type: "boolean" },
          verification_queries: { type: "array", items: { type: "string" } },
        },
        required: ["plan"],
        additionalProperties: false,
      },
      output: anyObject,
    },
    "memory.consolidation.verify": {
      input: {
        type: "object",
        properties: {
          queries: { type: "array", items: { type: "string" } },
          entity_keys: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      output: anyObject,
    },
    "memory.list": {
      input: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["global", "project"] },
          project_id: { type: "string" },
          kind: { type: "string" },
          search: { type: "string" },
          pinned: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
          offset: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      output: anyObject,
    },
    "memory.stats": {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: anyObject,
    },
    "memory.update": {
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: ["string", "null"] },
          tags: { type: "array", items: { type: "string" } },
          importance: { type: "integer", minimum: 1, maximum: 5 },
          pinned: { type: "boolean" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      output: anyObject,
    },
    "memory.delete": {
      input: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, minItems: 1 },
          confirmed: { type: "boolean" },
        },
        required: ["ids"],
        additionalProperties: false,
      },
      output: anyObject,
    },
    "budgets.list": {
      input: {
        type: "object",
        properties: { project_id: { type: "string" } },
        additionalProperties: false,
      },
      output: anyObject,
    },
    "budgets.set": {
      input: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["global", "phase", "task"] },
          project_id: { type: "string" },
          plan_id: { type: "string" },
          phase: { type: "integer", minimum: 0 },
          task_id: { type: "string" },
          token_budget: { type: "integer", minimum: 0 },
          max_cost_usd: { type: "number", minimum: 0 },
          confirmed: { type: "boolean" },
        },
        required: ["scope"],
        additionalProperties: false,
      },
      output: anyObject,
    },
    "executions.list": {
      input: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          agent_id: { type: "string" },
          model_id: { type: "string" },
          status: { type: "string" },
          role: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
          offset: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      output: anyObject,
    },
    "models.history": {
      input: {
        type: "object",
        properties: { role: { type: "string" } },
        required: ["role"],
        additionalProperties: false,
      },
      output: anyObject,
    },
    "agents.selection.get": {
      input: {
        type: "object",
        properties: { project_id: { type: "string" } },
        additionalProperties: false,
      },
      output: anyObject,
    },
    "agents.propose": {
      input: {
        type: "object",
        properties: {
          ambiguous_scope: { type: "boolean" },
          cross_module: { type: "boolean" },
          phase_plan: { type: "boolean" },
          handoff: { type: "boolean" },
          research: { type: "boolean" },
          second_opinion: { type: "boolean" },
        },
        additionalProperties: false,
      },
      output: anyObject,
    },
    "agents.selection.set": {
      input: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          mode: { type: "string", enum: ["auto", "manual", "hybrid"] },
          selected: { type: "array", items: { type: "string" }, minItems: 1 },
          recommended: { type: "array", items: { type: "string" } },
          apply_session: { type: "boolean" },
          session_id: { type: "string" },
          confirmed: { type: "boolean" },
        },
        required: ["mode", "selected"],
        additionalProperties: false,
      },
      output: anyObject,
    },
    "analytics.summary": {
      input: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          days: { type: "integer", minimum: 1, maximum: 365 },
        },
        additionalProperties: false,
      },
      output: anyObject,
    },
  },
  events: {},
});
