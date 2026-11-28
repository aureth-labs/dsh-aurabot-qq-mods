// Routing was exercised by the authorized 36-case batch. Subsequent parsing,
// lifecycle and bounded-context changes were replayed offline; no new live-model
// validation or general semantic-accuracy claim is implied.
export const CALIBRATION={provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off',maxOutputTokens:800,resultSHA256:'7763abbd1dfd4688ca31085ba61b41c740f17dff97a6d4f5fe943904bc7d7bea',evidence:'36 live outputs plus offline corrections',generalizationProven:false}
export const calibrated=judge=>judge.provider===CALIBRATION.provider&&judge.model===CALIBRATION.model&&judge.reasoningEffort===CALIBRATION.reasoningEffort&&judge.maxOutputTokens<=800
