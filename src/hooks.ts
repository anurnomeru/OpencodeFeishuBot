import type { NotificationType } from "./feishu/messages"

export function mapEventToNotification(eventType: string): NotificationType | null {
  switch (eventType) {
    case "permission.asked":
      return "permission_required"
    case "tui.prompt.append":
      return "interaction_required"
    case "question.asked":
      return "question_asked"
    default:
      return null
  }
}
