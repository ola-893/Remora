export function modelSettings(env) {
  const provider =
    env.AGENTPAY_AI_PROVIDER || (env.QWEN_API_KEY ? "qwen" : "openai");
  if (!["openai", "qwen"].includes(provider))
    throw new Error("AGENTPAY_AI_PROVIDER must be openai or qwen.");
  const apiKey =
    provider === "qwen"
      ? env.QWEN_API_KEY
      : env.OPENAI_API_KEY || env.OPEN_AI_KEY;
  if (!apiKey)
    throw new Error(
      `Set ${
        provider === "qwen"
          ? "QWEN_API_KEY"
          : "OPENAI_API_KEY (OPEN_AI_KEY alias accepted)"
      } in the ignored root .env.`
    );
  const model =
    provider === "qwen"
      ? env.QWEN_MODEL || "qwen3.5-plus"
      : env.OPENAI_MODEL || "gpt-4.1-mini";
  if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(model))
    throw new Error("Configured model name is invalid.");
  let endpoint = "https://api.openai.com/v1/responses";
  if (provider === "qwen") {
    const regions = {
      singapore: "dashscope-intl.aliyuncs.com",
      virginia: "dashscope-us.aliyuncs.com",
      beijing: "dashscope.aliyuncs.com",
    };
    const region = env.QWEN_REGION || "singapore";
    if (!regions[region])
      throw new Error("QWEN_REGION must be singapore, virginia or beijing.");
    try {
      const base = new URL(
        env.QWEN_BASE_URL || `https://${regions[region]}/compatible-mode/v1`
      );
      if (
        base.protocol !== "https:" ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        base.port ||
        (!Object.values(regions).includes(base.hostname) &&
          !/^[a-zA-Z0-9-]+\.(?:ap-southeast-1|us-east-1|cn-beijing)\.maas\.aliyuncs\.com$/.test(
            base.hostname
          )) ||
        base.pathname.replace(/\/$/, "") !== "/compatible-mode/v1"
      )
        throw new Error();
      endpoint = base.toString().replace(/\/$/, "") + "/responses";
    } catch {
      throw new Error(
        "QWEN_BASE_URL must be an official HTTPS Model Studio endpoint ending /compatible-mode/v1."
      );
    }
  }
  return { provider, apiKey, model, endpoint };
}
