import { harnessAdapters } from "@monde/adapters";

export function listAdapters(): void {
  for (const adapter of harnessAdapters) {
    const detection = adapter.detect();
    console.log(
      [
        adapter.id,
        detection.adapter_status,
        detection.mcp_status,
        detection.prompt_injection_status,
        detection.command ?? "-",
        detection.reason ?? detection.version ?? ""
      ].join("\t")
    );
  }
}

export function inspectAdapter(adapterId: string): void {
  const adapter = harnessAdapters.find((candidate) => candidate.id === adapterId);
  if (!adapter) {
    throw new Error(`Unknown adapter: ${adapterId}`);
  }

  const context = {
    runId: "run_example",
    runToken: "run_token_example",
    monRoot: "/path/to/example.mon",
    workRoot: "/path/to",
    prompt: "Example operator prompt",
    runtimePrompt: "Example Monde runtime prompt",
    model: null,
    serviceAddr: "http://127.0.0.1:3761",
    mcpAddr: "http://127.0.0.1:3762/mcp"
  };
  const detection = adapter.detect();

  console.log(
    JSON.stringify(
      {
        id: adapter.id,
        label: adapter.label,
        detection: {
          ...detection,
          path: detection.command ?? null
        },
        launch: safeInspect(() => adapter.buildCommand(context)),
        mcp_config: adapter.buildMcpConfig ? safeInspect(() => adapter.buildMcpConfig!(context)) : null,
        runtime_prompt_injection: safeInspect(() => adapter.buildRuntimePromptInjection(context))
      },
      null,
      2
    )
  );
}

function safeInspect<T>(fn: () => T): T | { error: string } {
  try {
    return fn();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
