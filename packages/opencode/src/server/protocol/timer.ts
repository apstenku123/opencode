import z from "zod"
import { TimerSvc } from "@/server/instance/timer"

export namespace TimerProtocol {
  export const Info = TimerSvc.Info
  export type Info = z.infer<typeof Info>

  export const Fired = TimerSvc.Fired
  export type Fired = z.infer<typeof Fired>

  export const CreateInput = TimerSvc.CreateInput
  export type CreateInput = z.infer<typeof CreateInput>

  export const ItemInput = TimerSvc.ItemInput
  export type ItemInput = z.infer<typeof ItemInput>

  export const ListResponse = z.object({ items: z.array(Info) }).meta({ ref: "TimerListResponse" })
  export type ListResponse = z.infer<typeof ListResponse>

  export const CreateResponse = z.object({ item: Info }).meta({ ref: "TimerCreateResponse" })
  export type CreateResponse = z.infer<typeof CreateResponse>

  export const PauseResponse = z.object({ item: Info.nullable() }).meta({ ref: "TimerPauseResponse" })
  export type PauseResponse = z.infer<typeof PauseResponse>

  export const ResumeResponse = z.object({ item: Info.nullable() }).meta({ ref: "TimerResumeResponse" })
  export type ResumeResponse = z.infer<typeof ResumeResponse>

  export const DeleteResponse = z.object({ ok: z.boolean() }).meta({ ref: "TimerDeleteResponse" })
  export type DeleteResponse = z.infer<typeof DeleteResponse>

  export const FiredNotification = z.object({ item: Fired }).meta({ ref: "TimerFiredNotification" })
  export type FiredNotification = z.infer<typeof FiredNotification>
}
