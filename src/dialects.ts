import {
  anthropicFailure,
  anthropicPrompt,
  anthropicResponse,
  openaiFailure,
  openaiResponse,
  toPrompt,
  type Answer,
  type Failure,
  type Prompt,
} from "./protocols.ts";
import { anthropicSink, openaiSink, type Sink } from "./stream.ts";

/** Everything the request handler needs to speak one vendor's wire format. The
 *  two completion routes are the same handler behind these. */
export interface Dialect {
  fail: (e: unknown) => Failure;
  prompt: (body: any) => Prompt;
  sink: (modelId: string, declared?: readonly string[]) => Sink;
  response: (modelId: string, answer: Answer) => object;
}

export const openai: Dialect = {
  fail: openaiFailure,
  prompt: (body) => toPrompt(body.messages, body.tools),
  sink: openaiSink,
  response: openaiResponse,
};

export const anthropic: Dialect = {
  fail: anthropicFailure,
  prompt: anthropicPrompt,
  sink: anthropicSink,
  response: anthropicResponse,
};
