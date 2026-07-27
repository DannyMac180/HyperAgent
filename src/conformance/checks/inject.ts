import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { InjectionResult } from "../../memory/inject.ts";
import type {
  ConformanceCheck,
  ConformanceCheckDependencies,
  InjectCheckDependencies,
} from "../runner.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return String(error);
  } catch {
    return "unknown thrown value";
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function isAtOrUnder(candidate: string, root: string): boolean {
  const pathFromRoot: string = relative(resolve(root), resolve(candidate));
  return (
    pathFromRoot === ""
    || (
      pathFromRoot !== ".."
      && !pathFromRoot.startsWith(`..${sep}`)
      && !isAbsolute(pathFromRoot)
    )
  );
}

function requirePathUnder(
  value: unknown,
  root: string,
  label: string,
): string {
  const candidate: string = requireNonEmptyString(value, label);
  if (!isAbsolute(candidate)) {
    throw new Error(`${label} must be absolute, got ${JSON.stringify(candidate)}`);
  }
  if (!isAtOrUnder(candidate, root)) {
    throw new Error(
      `${label} must stay under ${JSON.stringify(resolve(root))}, got `
      + JSON.stringify(resolve(candidate)),
    );
  }
  return resolve(candidate);
}

function validateResult(
  value: unknown,
  repoPath: string,
  label: string,
): InjectionResult {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must return a plain object`);
  }
  const targetPath: string = requirePathUnder(
    value.targetPath,
    repoPath,
    `${label}.targetPath`,
  );
  if (typeof value.changed !== "boolean") {
    throw new Error(`${label}.changed must be a boolean`);
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    throw new Error(`${label}.reason must be a string when supplied`);
  }
  return {
    targetPath,
    changed: value.changed,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  };
}

/**
 * Adapter calls intentionally have no wrapper timeout. The ConformanceCheck
 * contract assigns bounding and cancellation to descriptor implementations
 * because the vendor-blind core cannot safely cancel arbitrary filesystem IO.
 */
async function render(
  deps: InjectCheckDependencies,
  repoPath: string,
  memories: InjectCheckDependencies["fixtures"]["memories"],
  label: string,
): Promise<InjectionResult> {
  try {
    return validateResult(
      await deps.fixtures.adapter.renderInjection(repoPath, memories),
      repoPath,
      `${label}.renderInjection()`,
    );
  } catch (error: unknown) {
    throw new Error(`${label} render failed: ${errorMessage(error)}`);
  }
}

async function createRepo(
  contextRoot: string,
  label: string,
  withGit = true,
): Promise<string> {
  const tempRoot: string = requirePathUnder(
    contextRoot,
    contextRoot,
    "context.tempRoot",
  );
  try {
    const repoPath: string = await mkdtemp(join(tempRoot, `${label}-`));
    if (withGit) {
      await mkdir(join(repoPath, ".git"));
    }
    return repoPath;
  } catch (error: unknown) {
    throw new Error(`${label} repo creation failed: ${errorMessage(error)}`);
  }
}

function artifactPath(
  deps: InjectCheckDependencies,
  repoPath: string,
  label: string,
): string {
  let candidate: unknown;
  try {
    candidate = deps.fixtures.managedArtifactPath(repoPath);
  } catch (error: unknown) {
    throw new Error(`${label} path resolution failed: ${errorMessage(error)}`);
  }
  return requirePathUnder(candidate, repoPath, `${label} path`);
}

async function readArtifact(path: string, label: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    throw new Error(
      `${label} could not read ${JSON.stringify(path)}: ${errorMessage(error)}`,
    );
  }
}

function assertSuccessfulWrite(result: InjectionResult, label: string): void {
  if (!result.changed) {
    throw new Error(
      `${label} unexpectedly declined to write: `
      + (result.reason?.trim() || "no refusal reason supplied"),
    );
  }
  if (result.reason !== undefined && result.reason.trim().length > 0) {
    throw new Error(
      `${label} reported changed=true with reason ${JSON.stringify(result.reason)}`,
    );
  }
}

function injectCheck(
  id: string,
  run: (deps: InjectCheckDependencies) => Promise<string>,
): ConformanceCheck {
  return {
    id,
    capability: "inject",
    async run(deps: ConformanceCheckDependencies): Promise<string> {
      if (deps.capability !== "inject") {
        throw new Error(`${id} requires inject dependencies`);
      }
      return run(deps);
    },
  };
}

const roundTripCheck: ConformanceCheck = injectCheck(
  "inject.round-trip",
  async (deps): Promise<string> => {
    const sentinel: string = requireNonEmptyString(
      deps.fixtures.sentinel,
      "inject fixture sentinel",
    );
    const repoPath: string = await createRepo(
      deps.context.tempRoot,
      "inject-round-trip",
    );
    const result: InjectionResult = await render(
      deps,
      repoPath,
      deps.fixtures.memories,
      "round-trip",
    );
    assertSuccessfulWrite(result, "round-trip");
    const path: string = artifactPath(deps, repoPath, "round-trip artifact");
    const contents: Buffer = await readArtifact(path, "round-trip");
    if (!contents.includes(Buffer.from(sentinel))) {
      throw new Error(
        `round-trip artifact ${JSON.stringify(path)} did not contain sentinel `
        + JSON.stringify(sentinel),
      );
    }
    return `sentinel read back from ${path}`;
  },
);

const idempotencyCheck: ConformanceCheck = injectCheck(
  "inject.idempotency",
  async (deps): Promise<string> => {
    const repoPath: string = await createRepo(
      deps.context.tempRoot,
      "inject-idempotency",
    );
    const path: string = artifactPath(deps, repoPath, "idempotency artifact");
    const firstResult: InjectionResult = await render(
      deps,
      repoPath,
      deps.fixtures.memories,
      "idempotency pass 1",
    );
    assertSuccessfulWrite(firstResult, "idempotency pass 1");
    const firstBytes: Buffer = await readArtifact(path, "idempotency pass 1");
    const secondResult: InjectionResult = await render(
      deps,
      repoPath,
      deps.fixtures.memories,
      "idempotency pass 2",
    );
    const secondBytes: Buffer = await readArtifact(path, "idempotency pass 2");
    if (!firstBytes.equals(secondBytes)) {
      throw new Error(
        `idempotency bytes changed on the second render: `
        + `${firstBytes.length} byte(s) became ${secondBytes.length} byte(s)`,
      );
    }
    if (secondResult.changed) {
      throw new Error("idempotency pass 2 reported changed=true");
    }
    // A correct no-op may explain why it declined to write; that does not
    // weaken the byte-identity and changed=false idempotency contract.
    return `${secondBytes.length} artifact byte(s) remained identical`;
  },
);

const removalCheck: ConformanceCheck = injectCheck(
  "inject.removal",
  async (deps): Promise<string> => {
    const sentinel: string = requireNonEmptyString(
      deps.fixtures.sentinel,
      "inject fixture sentinel",
    );
    const foreignContent: string = requireNonEmptyString(
      deps.fixtures.foreignContent,
      "inject fixture foreignContent",
    );
    const repoPath: string = await createRepo(
      deps.context.tempRoot,
      "inject-removal",
    );
    const path: string = artifactPath(deps, repoPath, "removal artifact");
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, foreignContent, "utf8");
    } catch (error: unknown) {
      throw new Error(
        `removal fixture setup failed for ${JSON.stringify(path)}: `
        + errorMessage(error),
      );
    }
    const populatedResult: InjectionResult = await render(
      deps,
      repoPath,
      deps.fixtures.memories,
      "removal populated pass",
    );
    if (
      !populatedResult.changed
      && populatedResult.reason !== undefined
      && populatedResult.reason.trim().length > 0
    ) {
      throw new Error(
        `removal populated pass was refused: ${populatedResult.reason}`,
      );
    }
    const emptyResult: InjectionResult = await render(
      deps,
      repoPath,
      [],
      "removal empty pass",
    );
    if (
      !emptyResult.changed
      && emptyResult.reason !== undefined
      && emptyResult.reason.trim().length > 0
    ) {
      throw new Error(`removal empty pass was refused: ${emptyResult.reason}`);
    }
    const finalBytes: Buffer = await readArtifact(path, "removal final read");
    const finalContent: string = finalBytes.toString("utf8");
    if (finalContent.includes(sentinel)) {
      throw new Error(
        `removal artifact still contains sentinel ${JSON.stringify(sentinel)}`,
      );
    }
    if (!finalContent.includes(foreignContent)) {
      throw new Error(
        `removal artifact did not preserve foreign content verbatim: `
        + JSON.stringify(foreignContent),
      );
    }
    return `managed sentinel removed and ${foreignContent.length} foreign byte(s) preserved`;
  },
);

const refusalCheck: ConformanceCheck = injectCheck(
  "inject.refusal",
  async (deps): Promise<string> => {
    const refusalRoot: string = requirePathUnder(
      deps.fixtures.refusalRoot,
      deps.context.tempRoot,
      "inject fixture refusalRoot",
    );
    const refusedLabels: string[] = [];
    for (const pattern of deps.descriptor.forbiddenTargetPatterns) {
      const targetPath: string = requirePathUnder(
        resolve(refusalRoot, pattern, "repo"),
        refusalRoot,
        `forbidden target ${JSON.stringify(pattern)}`,
      );
      try {
        await mkdir(join(targetPath, ".git"), { recursive: true });
      } catch (error: unknown) {
        throw new Error(
          `forbidden target setup failed for ${JSON.stringify(pattern)}: `
          + errorMessage(error),
        );
      }
      const path: string = artifactPath(
        deps,
        targetPath,
        `forbidden ${JSON.stringify(pattern)} artifact`,
      );
      const result: InjectionResult = await render(
        deps,
        targetPath,
        deps.fixtures.memories,
        `forbidden target ${JSON.stringify(pattern)}`,
      );
      if (result.changed) {
        throw new Error(
          `forbidden target ${JSON.stringify(pattern)} reported changed=true`,
        );
      }
      if (result.reason === undefined || result.reason.trim().length === 0) {
        throw new Error(
          `forbidden target ${JSON.stringify(pattern)} supplied no refusal reason`,
        );
      }
      if (await Bun.file(path).exists()) {
        throw new Error(
          `forbidden target ${JSON.stringify(pattern)} wrote managed artifact `
          + JSON.stringify(path),
        );
      }
      refusedLabels.push(pattern);
    }

    const noGitPath: string = await createRepo(
      deps.context.tempRoot,
      "inject-no-git",
      false,
    );
    const noGitArtifact: string = artifactPath(
      deps,
      noGitPath,
      "no-.git artifact",
    );
    const noGitResult: InjectionResult = await render(
      deps,
      noGitPath,
      deps.fixtures.memories,
      "no-.git target",
    );
    if (noGitResult.changed) {
      throw new Error("target without .git reported changed=true");
    }
    if (
      noGitResult.reason === undefined
      || noGitResult.reason.trim().length === 0
    ) {
      throw new Error("target without .git supplied no refusal reason");
    }
    if (await Bun.file(noGitArtifact).exists()) {
      throw new Error(
        `target without .git wrote managed artifact `
        + JSON.stringify(noGitArtifact),
      );
    }

    const patternDetail: string = refusedLabels.length === 0
      ? "no forbidden patterns declared"
      : `${refusedLabels.length} forbidden pattern(s) refused`;
    return `${patternDetail}; target without .git refused`;
  },
);

export const INJECT_CHECKS: readonly ConformanceCheck[] = [
  roundTripCheck,
  idempotencyCheck,
  removalCheck,
  refusalCheck,
];
