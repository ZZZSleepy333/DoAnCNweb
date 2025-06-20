import prisma from "@/app/libs/prismadb";
import getCurrentUser from "@/app/actions/getCurrentUser";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const currentUser = await getCurrentUser();

  if (!currentUser) {
    return NextResponse.json(
      { message: "An error occurred." },
      { status: 500 }
    );
  }

  const body = await request.json();
  const { content, conversationId, receiverId, reservationId } = body;

  if (!content || (!conversationId && !receiverId)) {
    return NextResponse.json(
      { message: "An error occurred." },
      { status: 500 }
    );
  }

  try {
    let conversation;

    if (conversationId) {
      conversation = await prisma.conversation.findUnique({
        where: {
          id: conversationId,
        },
      });
    } else {
      const participantIds = [currentUser.id, receiverId].sort();

      conversation = await prisma.conversation.findFirst({
        where: {
          AND: [
            { participantIds: { has: currentUser.id } },
            { participantIds: { has: receiverId } },
          ],
        },
      });

      if (conversation && conversation.participantIds.length !== 2) {
        conversation = null;
      }
    }

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          participantIds: [currentUser.id, receiverId].sort(),
          lastMessageAt: new Date(),
          reservationId: reservationId,
        },
      });
    }

    if (!conversation) {
      return NextResponse.json(
        { message: "An error occurred." },
        { status: 500 }
      );
    }

    const message = await prisma.message.create({
      data: {
        content,
        senderId: currentUser.id,
        userId: currentUser.id,
        conversationId: conversation.id,
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
    });

    const participants = conversation.participantIds;
    const otherParticipantId = participants.find((id) => id !== currentUser.id);

    let listingTitle = "Unknown Property";
    if (conversation.reservationId) {
      const reservation = await prisma.reservation.findUnique({
        where: { id: conversation.reservationId },
        include: { listing: { select: { title: true } } },
      });
      listingTitle = reservation?.listing?.title || listingTitle;
    }

    await prisma.conversation.update({
      where: {
        id: conversation.id,
      },
      data: {
        lastMessageAt: new Date(),
      },
    });

    if (otherParticipantId) {
      await prisma.notification.create({
        data: {
          userId: otherParticipantId,
          type: "message",
          title: `New message from ${currentUser.name}`,
          message:
            content.length > 100 ? `${content.substring(0, 100)}...` : content,
          data: {
            conversationId: conversation.id,
            messageId: message.id,
            senderId: currentUser.id,
            senderName: currentUser.name,
            listingTitle,
          },
        },
      });
    }

    try {
      const globalAny: any = globalThis;
      if (globalAny.ioServer) {
        globalAny.ioServer
          .to(`conversation-${conversation.id}`)
          .emit("new-message", {
            ...message,
            conversationId: conversation.id,
          });

        if (otherParticipantId) {
          globalAny.ioServer
            .to(`user-${otherParticipantId}`)
            .emit("new-notification", {
              id: Date.now().toString(),
              type: "message",
              title: `New message from ${currentUser.name}`,
              message:
                content.length > 100
                  ? `${content.substring(0, 100)}...`
                  : content,
              data: {
                conversationId: conversation.id,
                messageId: message.id,
                senderId: currentUser.id,
                senderName: currentUser.name,
                listingTitle,
              },
              read: false,
              createdAt: new Date().toISOString(),
            });
        }
      }
    } catch (socketError) {
      console.log("Socket.IO not available, skipping real-time events");
    }

    return NextResponse.json(message);
  } catch (error) {
    console.error("Error creating message:", error);
    return NextResponse.json(
      { message: "An error occurred." },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  const currentUser = await getCurrentUser();

  if (!currentUser) {
    return NextResponse.json(
      { message: "An error occurred." },
      { status: 500 }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get("conversationId");
    const receiverId = searchParams.get("receiverId");

    if (!conversationId && !receiverId) {
      return NextResponse.json(
        { message: "An error occurred." },
        { status: 500 }
      );
    }

    let conversation;

    if (conversationId) {
      conversation = await prisma.conversation.findUnique({
        where: {
          id: conversationId,
        },
        include: {
          messages: {
            include: {
              sender: {
                select: {
                  id: true,
                  name: true,
                  image: true,
                },
              },
            },
            orderBy: {
              createdAt: "asc",
            },
          },
        },
      });
    } else if (receiverId) {
      conversation = await prisma.conversation.findFirst({
        where: {
          participantIds: {
            hasEvery: [currentUser.id, receiverId],
          },
        },
        include: {
          messages: {
            include: {
              sender: {
                select: {
                  id: true,
                  name: true,
                  image: true,
                },
              },
            },
            orderBy: {
              createdAt: "asc",
            },
          },
        },
      });
    }

    return NextResponse.json(conversation?.messages || []);
  } catch (error) {
    console.error("Error fetching messages:", error);
    return NextResponse.json(
      { message: "An error occurred." },
      { status: 500 }
    );
  }
}
