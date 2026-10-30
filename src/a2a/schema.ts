import { z } from "zod";

/**
 * A2A (agent-to-agent) payment request.
 *
 * In the HSP A2A scenario, a Receiving Agent transmits payment CONDITIONS to the
 * Payment Agent. The Payment Agent turns these conditions into an HSP order
 * (cart_mandate), signs the returned EIP-712, and settles through the HSP Gateway.
 *
 * This schema is the contract between the two agents. It is intentionally
 * transport-agnostic — carry it over any A2A channel (in-process, HTTP, a message
 * bus, or a formal A2A protocol envelope).
 */
export const PaymentRequestSchema = z.object({
  /** Stable id for this request (idempotency + correlation). */
  id: z.string().min(1),

  /** Human-readable label for the receiving agent / merchant. */
  merchantName: z.string().min(1),

  /** Recipient EVM address: 42 chars, 0x + 40 hex. */
  payTo: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "payTo must be a 0x EVM address (42 chars)"),

  /** Amount the receiving agent is asking for. HSP cart currency is always USD. */
  amount: z.object({
    value: z.string().min(1), // decimal string, e.g. "1" or "1.50"
    currency: z.literal("USD"),
  }),

  /** RFC3339 expiry after which the Payment Agent must not fulfil this request. */
  expiry: z.string().min(1),

  /** Free-form description of what is being paid for. */
  description: z.string().optional(),

  /** Optional constraints the receiving agent imposes (network/token preferences). */
  constraints: z
    .object({
      network: z.string().optional(),
      tokenSymbol: z.string().optional(),
    })
    .optional(),
});

export type PaymentRequest = z.infer<typeof PaymentRequestSchema>;

export function parsePaymentRequest(input: unknown): PaymentRequest {
  return PaymentRequestSchema.parse(input);
}
