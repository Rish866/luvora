import type { PoolClient } from "pg";
import { pool, withTransaction } from "./pool";
import { logger } from "../logger";

/**
 * Deterministic, idempotent seeding of a small set of safe, NON-GRAPHIC demo
 * scenarios. Re-running is a no-op (keyed on scenario slug + version number).
 *
 * A scenario is defined as plain data here (content is data, not code) and
 * inserted as an immutable PUBLISHED version with its node graph. node_key /
 * choice_key values make the graph human-readable and let choices reference
 * destinations by key, which the seeder resolves to node ids.
 */

interface SeedChoice {
  key: string;
  label: string;
  description?: string;
  to: string; // destination node_key
  requires?: string[]; // consent categories required
}

interface SeedNode {
  key: string;
  type: "START" | "NARRATIVE" | "CHOICE" | "ENDING";
  title: string;
  content: string;
  choices?: SeedChoice[];
}

interface SeedScenario {
  slug: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  estimatedMinutes: number;
  startNode: string;
  nodes: SeedNode[];
}

/** The demo library. Deliberately small (5), all non-explicit, demonstrating:
 *  linear, branching, consent-gated choices, multiple endings, replayability. */
const SCENARIOS: SeedScenario[] = [
  {
    slug: "the-midnight-masquerade",
    title: "The Midnight Masquerade",
    description:
      "A masked ball, a stranger who seems to know you, and a single night to decide how bold you dare to be.",
    category: "romance",
    tags: ["masquerade", "mystery", "romance"],
    estimatedMinutes: 10,
    startNode: "start",
    nodes: [
      {
        key: "start",
        type: "START",
        title: "The Invitation",
        content:
          "Gold light spills from the ballroom. A masked figure offers you their hand. 'I hoped you'd come,' they say.",
        choices: [
          { key: "take_hand", label: "Take their hand", to: "dance" },
          { key: "step_back", label: "Step back and watch", to: "balcony" },
        ],
      },
      {
        key: "dance",
        type: "CHOICE",
        title: "A Dance",
        content:
          "You move together through the crowd. Their eyes never leave yours. 'Tell me something true,' they whisper.",
        choices: [
          {
            key: "flirt",
            label: "Answer with a playful tease",
            to: "unmasking",
            requires: ["flirting"],
          },
          { key: "honest", label: "Answer honestly and softly", to: "unmasking" },
        ],
      },
      {
        key: "balcony",
        type: "CHOICE",
        title: "The Balcony",
        content:
          "You slip to the balcony. The city glitters. Moments later, they join you, mask still in place.",
        choices: [
          { key: "invite_closer", label: "Invite them closer", to: "unmasking" },
          { key: "keep_distance", label: "Keep a mysterious distance", to: "ending_mystery" },
        ],
      },
      {
        key: "unmasking",
        type: "CHOICE",
        title: "The Unmasking",
        content:
          "Midnight chimes. 'Masks off at midnight — those are the rules,' they laugh. 'Shall we?'",
        choices: [
          { key: "unmask", label: "Lower your mask together", to: "ending_together" },
          { key: "one_more", label: "Ask for one more dance first", to: "ending_dance" },
        ],
      },
      {
        key: "ending_together",
        type: "ENDING",
        title: "Ending: Unmasked",
        content:
          "Two faces, finally seen. Whatever happens next, tonight you chose to be known.",
      },
      {
        key: "ending_dance",
        type: "ENDING",
        title: "Ending: One More Song",
        content:
          "The band plays on. You decide the night is young and the mystery is half the fun.",
      },
      {
        key: "ending_mystery",
        type: "ENDING",
        title: "Ending: The Lingering Mystery",
        content:
          "They vanish into the crowd with a backward glance. Some stories are sweeter unfinished.",
      },
    ],
  },
  {
    slug: "the-rooftop-secret",
    title: "The Rooftop Secret",
    description: "A quiet rooftop, a shared secret, and the courage to say what you mean.",
    category: "romance",
    tags: ["slow burn", "confession"],
    estimatedMinutes: 6,
    startNode: "start",
    nodes: [
      {
        key: "start",
        type: "START",
        title: "Above the City",
        content:
          "You both climbed up here to escape the party. The silence is comfortable. Then they say your name.",
        choices: [
          { key: "listen", label: "Turn and listen", to: "confession" },
        ],
      },
      {
        key: "confession",
        type: "CHOICE",
        title: "The Secret",
        content:
          "'I've wanted to tell you something for a while,' they admit, nervous for the first time.",
        choices: [
          { key: "encourage", label: "Gently encourage them", to: "ending_warm" },
          {
            key: "tease",
            label: "Tease them to ease the tension",
            to: "ending_light",
            requires: ["teasing"],
          },
        ],
      },
      {
        key: "ending_warm",
        type: "ENDING",
        title: "Ending: Said Out Loud",
        content: "The secret is spoken, and the night feels a little warmer for it.",
      },
      {
        key: "ending_light",
        type: "ENDING",
        title: "Ending: Laughing It Off",
        content: "You both laugh, the tension melts, and the real conversation can finally begin.",
      },
    ],
  },
  {
    slug: "the-enchanted-inn",
    title: "The Enchanted Inn",
    description:
      "Snowed in at a tiny inn that may be a little bit magical, you share the last warm room.",
    category: "fantasy",
    tags: ["fantasy", "cozy", "adventure"],
    estimatedMinutes: 8,
    startNode: "start",
    nodes: [
      {
        key: "start",
        type: "START",
        title: "The Last Room",
        content:
          "The storm won't let up. The innkeeper winks: 'One room left, and the fire tells fortunes.'",
        choices: [
          { key: "fire", label: "Ask the fire for a fortune", to: "fortune" },
          { key: "window", label: "Watch the snow together", to: "ending_quiet" },
        ],
      },
      {
        key: "fortune",
        type: "CHOICE",
        title: "The Fire's Fortune",
        content:
          "Shapes dance in the flames — two travelers, a long road, a choice. 'Play along?' they ask.",
        choices: [
          {
            key: "roleplay",
            label: "Step into the story as characters",
            to: "ending_adventure",
            requires: ["roleplay"],
          },
          { key: "stay_you", label: "Stay yourselves and simply talk", to: "ending_quiet" },
        ],
      },
      {
        key: "ending_adventure",
        type: "ENDING",
        title: "Ending: The Tale You Told",
        content: "You spin a shared tale late into the night, two heroes by firelight.",
      },
      {
        key: "ending_quiet",
        type: "ENDING",
        title: "Ending: Snowbound",
        content: "The storm howls outside; inside, there is only easy quiet and good company.",
      },
    ],
  },
  {
    slug: "the-vanishing-letter",
    title: "The Vanishing Letter",
    description: "A detective and a suspect, a missing letter, and a mystery only you two can solve.",
    category: "mystery",
    tags: ["mystery", "detective"],
    estimatedMinutes: 9,
    startNode: "start",
    nodes: [
      {
        key: "start",
        type: "START",
        title: "The Case",
        content:
          "The letter was here an hour ago. Now it's gone. You two are the only ones who can piece it together.",
        choices: [
          { key: "study", label: "Search the study", to: "clue" },
          { key: "garden", label: "Check the garden path", to: "clue" },
        ],
      },
      {
        key: "clue",
        type: "CHOICE",
        title: "A Clue",
        content: "A faint clue surfaces. 'We make a good team,' they say, almost surprised.",
        choices: [
          {
            key: "mystery_deepens",
            label: "Follow the trail into deeper intrigue",
            to: "ending_solved",
            requires: ["mystery"],
          },
          { key: "call_it", label: "Decide the mystery can wait", to: "ending_pause" },
        ],
      },
      {
        key: "ending_solved",
        type: "ENDING",
        title: "Ending: Case Closed",
        content: "The letter is found, the truth revealed — and a partnership begun.",
      },
      {
        key: "ending_pause",
        type: "ENDING",
        title: "Ending: To Be Continued",
        content: "Some mysteries are an excuse to meet again. You both know you will.",
      },
    ],
  },
  {
    slug: "the-hidden-garden",
    title: "The Hidden Garden",
    description: "A door in a wall, a garden no map shows, and an afternoon that feels like a secret.",
    category: "romance",
    tags: ["slow burn", "wholesome"],
    estimatedMinutes: 5,
    startNode: "start",
    nodes: [
      {
        key: "start",
        type: "START",
        title: "The Door in the Wall",
        content: "You found it together — a green door no one else seems to notice. It's unlocked.",
        choices: [{ key: "enter", label: "Step inside", to: "ending_bloom" }],
      },
      {
        key: "ending_bloom",
        type: "ENDING",
        title: "Ending: In Bloom",
        content: "The garden is impossibly alive. For one afternoon, it belongs only to you two.",
      },
    ],
  },
];

async function seedScenario(client: PoolClient, s: SeedScenario): Promise<void> {
  // Upsert the scenario (PUBLISHED), keyed on slug.
  const scenarioRes = await client.query<{ id: string }>(
    `INSERT INTO scenarios (slug, title, description, category, tags, estimated_minutes, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'PUBLISHED')
     ON CONFLICT (lower(slug)) DO UPDATE
        SET title = EXCLUDED.title,
            description = EXCLUDED.description,
            category = EXCLUDED.category,
            tags = EXCLUDED.tags,
            estimated_minutes = EXCLUDED.estimated_minutes,
            status = 'PUBLISHED'
     RETURNING id`,
    [s.slug, s.title, s.description, s.category, s.tags, s.estimatedMinutes],
  );
  const scenarioId = scenarioRes.rows[0].id;

  // Does a published version 1 already exist? If so, this scenario is seeded.
  const existingVersion = await client.query<{ id: string }>(
    `SELECT id FROM scenario_versions WHERE scenario_id = $1 AND version = 1`,
    [scenarioId],
  );
  if (existingVersion.rows[0]) {
    return; // idempotent: content already seeded
  }

  // Create version 1 (start_node_id filled in after nodes exist).
  const versionRes = await client.query<{ id: string }>(
    `INSERT INTO scenario_versions (scenario_id, version, status, published_at)
     VALUES ($1, 1, 'PUBLISHED', now())
     RETURNING id`,
    [scenarioId],
  );
  const versionId = versionRes.rows[0].id;

  // Insert nodes, remembering key -> id.
  const nodeIdByKey = new Map<string, string>();
  let order = 0;
  for (const node of s.nodes) {
    const res = await client.query<{ id: string }>(
      `INSERT INTO scenario_nodes
         (scenario_version_id, node_key, node_type, title, content, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [versionId, node.key, node.type, node.title, node.content, order++],
    );
    nodeIdByKey.set(node.key, res.rows[0].id);
  }

  // Insert choices (resolving destination keys to ids) + requirements.
  for (const node of s.nodes) {
    const nodeId = nodeIdByKey.get(node.key)!;
    let choiceOrder = 0;
    for (const choice of node.choices ?? []) {
      const nextId = nodeIdByKey.get(choice.to);
      if (!nextId) {
        throw new Error(
          `Scenario ${s.slug}: choice ${choice.key} references unknown node ${choice.to}`,
        );
      }
      const choiceRes = await client.query<{ id: string }>(
        `INSERT INTO scenario_choices
           (node_id, choice_key, label, description, next_node_id, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [nodeId, choice.key, choice.label, choice.description ?? "", nextId, choiceOrder++],
      );
      const choiceId = choiceRes.rows[0].id;
      for (const cat of choice.requires ?? []) {
        await client.query(
          `INSERT INTO scenario_choice_requirements (choice_id, consent_category)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [choiceId, cat],
        );
      }
    }
  }

  // Set the version's start node.
  const startId = nodeIdByKey.get(s.startNode);
  if (!startId) throw new Error(`Scenario ${s.slug}: start node ${s.startNode} missing`);
  await client.query(
    `UPDATE scenario_versions SET start_node_id = $1 WHERE id = $2`,
    [startId, versionId],
  );
}

export async function seedScenarios(): Promise<void> {
  await withTransaction(async (client) => {
    for (const s of SCENARIOS) {
      await seedScenario(client, s);
    }
  });
  logger.info({ count: SCENARIOS.length }, "scenario seed complete");
}

/** The slugs seeded, for tests/smoke to reference deterministically. */
export const SEEDED_SCENARIO_SLUGS = SCENARIOS.map((s) => s.slug);

if (require.main === module) {
  seedScenarios()
    .then(() => pool.end())
    .catch((err) => {
      logger.error({ err }, "scenario seed failed");
      process.exitCode = 1;
      return pool.end();
    });
}
