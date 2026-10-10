export interface SampleChat {
  id: string;
  name: string;
  description: string;
  timezone: string;
  raw: string;
}

const RIVERA = `10/3/26, 7:41 PM - Mom: ok whoever left their cleats in the garage they are going in the bin
10/3/26, 7:42 PM - Sam: lol
10/3/26, 7:43 PM - Dad: who's driving Sam to practice?
10/3/26, 7:44 PM - Mom: Practice moved to next Tuesday at 5, permission slip due Friday!
10/3/26, 7:44 PM - Dad: I can take them
10/3/26, 7:45 PM - Aunt Rosa: 👍
10/3/26, 7:45 PM - Sam: can we stop for boba after
10/3/26, 7:46 PM - Mom: we'll see lol
10/4/26, 9:12 AM - Mom: Grandma's 80th is Nov 14 at 6pm at Lucia's, save the date!
10/4/26, 9:13 AM - Aunt Rosa: omg 80!! 🎉
10/4/26, 9:13 AM - Dad: what should we get her
10/4/26, 9:14 AM - Mom: she said no gifts, just everyone there
10/4/26, 9:14 AM - Aunt Rosa: we'll see about that lol
10/4/26, 12:02 PM - Sam: meme.jpg
10/4/26, 12:03 PM - Mom: 🙄
10/4/26, 6:30 PM - Dad: dentist tomorrow at 9:30 for Sam, I'll drive
10/4/26, 6:31 PM - Mom: ok thanks
10/5/26, 8:00 AM - Dad:Reminder: dentist is today
10/5/26, 8:15 AM - Sam: I feel fine
10/5/26, 8:16 AM - Mom: you're still going
10/5/26, 4:20 PM - Mom: movie night Friday is cancelled, Dad has a work thing
10/5/26, 4:21 PM - Sam: 😭
10/5/26, 4:22 PM - Aunt Rosa: next time!
10/6/26, 10:05 AM - Mom: change of plans, Grandma's dinner is actually moving it to Saturday the 15th, same time same place
10/6/26, 10:06 AM - Dad: works for me
10/6/26, 10:06 AM - Aunt Rosa: I'll be there
10/6/26, 10:07 AM - Mom: are you coming Sam?
10/6/26, 11:30 AM - Sam: yes I'll be there
10/6/26, 11:31 AM - Aunt Rosa: me too
10/6/26, 3:15 PM - Mom: who is coming to Grandma's dinner on the 15th?
10/6/26, 3:16 PM - Dad: I'm in
10/6/26, 3:20 PM - Aunt Rosa: bringing the flan
10/7/26, 5:40 PM - Sam: practice was moved again?
10/7/26, 5:41 PM - Mom: no, Tuesday at 5 still
10/8/26, 8:55 PM - Dad: I booked the dentist follow up for Sam next Wednesday at 4
10/8/26, 8:56 PM - Mom: ok
10/9/26, 1:12 PM - Aunt Rosa: sending the invitation for Grandma's party, check your email
10/9/26, 1:13 PM - Mom: got it
10/9/26, 1:14 PM - Dad: got it
10/9/26, 1:30 PM - Sam: meme2.jpg
10/10/26, 9:00 AM - Mom: don't forget the permission slip is due tomorrow!
10/10/26, 9:01 AM - Sam: I'll print it
10/10/26, 9:02 AM - Mom: printing it now, here
10/10/26, 9:03 AM - Sam: thanks
10/10/26, 12:00 PM - Dad: Anyone want anything from Costco?
10/10/26, 12:01 PM - Mom: bananas lol
10/10/26, 12:02 PM - Sam: taquitos
10/11/26, 7:30 PM - Mom: Grandma's dinner confirmations: me, Dad, Rosa, Sam, and Tio Joe said he's coming
10/11/26, 7:31 PM - Aunt Rosa: perfect
10/11/26, 8:00 PM - Mom: soccer carpool Tuesday: I leave at 4:15
10/11/26, 8:01 PM - Dad: we'll be ready`;

const LAKE_TRIP = `10/3/26, 10:02 AM - Priya: OK LAKE TRIP let's lock dates, thinking Oct 24-26
10/3/26, 10:04 AM - Marcus: I'm in for that weekend
10/3/26, 10:05 AM - Jen: works for me
10/3/26, 10:06 AM - Priya: deposit due by the 20th to the cabin site, $40 each
10/3/26, 10:07 AM - Marcus: I'll send mine today
10/3/26, 10:08 AM - Jen: sending tonight
10/3/26, 10:09 AM - Priya: sent
10/3/26, 11:30 AM - Marcus: who's bringing the kayak
10/3/26, 11:32 AM - Jen: I have the two seater
10/3/26, 11:33 AM - Priya: I'll bring the cooler
10/4/26, 9:00 AM - Marcus: weather looks good for the 24th
10/4/26, 9:05 AM - Priya: grocery run Saturday morning Oct 24 at 9 before we drive up
10/4/26, 9:06 AM - Jen: I can join that
10/4/26, 9:07 AM - Marcus: I'll be there
10/5/26, 2:15 PM - Priya: reminder: deposit due by the 20th!
10/5/26, 2:16 PM - Marcus: did mine go through, sent yesterday
10/5/26, 2:20 PM - Priya: yes, got it
10/5/26, 2:21 PM - Jen: mine sent too
10/6/26, 7:45 PM - Jen: cabin has a fire pit, bringing s'mores stuff
10/6/26, 7:46 PM - Marcus: elite
10/7/26, 12:00 PM - Priya: who is actually coming to the lake weekend? need headcount for the cabin
10/7/26, 12:02 PM - Marcus: yes I'll be there
10/7/26, 12:03 PM - Jen: yes coming
10/7/26, 12:05 PM - Priya: that's 3, booking for 3
10/8/26, 6:30 PM - Marcus: can we move the grocery run to Oct 24 at 10? I have an early thing
10/8/26, 6:32 PM - Priya: 10am works
10/8/26, 6:33 PM - Jen: fine by me
10/9/26, 8:00 AM - Jen: packing list posted, check the doc
10/10/26, 5:15 PM - Priya: one week out! balance for the cabin due by the 26th at check in
10/10/26, 5:16 PM - Marcus: got it
10/10/26, 5:17 PM - Jen: 👍`;

const ROOM_4B = `10/6/26, 8:15 AM - Ms. Alvarez: Good morning Room 4B parents! Bake sale next Friday Oct 16, drop off treats by 8am
10/6/26, 8:20 AM - Parent Kim: I'll make brownies
10/6/26, 8:21 AM - Parent Dan: cookies here
10/6/26, 8:22 AM - Ms. Alvarez: thank you both!
10/6/26, 12:10 PM - Parent Kim: is the bake sale during lunch?
10/6/26, 12:11 PM - Ms. Alvarez: yes, 11:30 to 1
10/7/26, 9:00 AM - Ms. Alvarez: Reminder: early dismissal this Thursday at 1:15
10/7/26, 9:01 AM - Parent Dan: pickup at 3?
10/7/26, 9:02 AM - Ms. Alvarez: no, 1:15 that day
10/7/26, 9:03 AM - Parent Kim: got it
10/8/26, 3:30 PM - Ms. Alvarez: picture day is Oct 21, order forms going home today
10/8/26, 3:31 PM - Parent Kim: what should they wear?
10/8/26, 3:32 PM - Ms. Alvarez: whatever you like, backgrounds are neutral
10/9/26, 8:00 AM - Parent Dan: who is coming to the bake sale table? we need 2 volunteers
10/9/26, 8:05 AM - Parent Kim: I can do it
10/9/26, 8:06 AM - Parent Dan: perfect, one more?
10/9/26, 8:10 AM - Ms. Alvarez: I'll cover the second slot
10/10/26, 4:45 PM - Ms. Alvarez: Field trip forms due next Wednesday Oct 21
10/10/26, 4:46 PM - Parent Kim: when is the field trip itself?
10/10/26, 4:47 PM - Ms. Alvarez: Oct 28, more details coming
10/11/26, 6:00 PM - Parent Dan: see everyone at pickup`;

export const SAMPLE_CHATS: SampleChat[] = [
  {
    id: "rivera",
    name: "Rivera Family",
    description: "Soccer, birthdays, dentist trips — and plenty of noise",
    timezone: "America/Los_Angeles",
    raw: RIVERA,
  },
  {
    id: "lake",
    name: "Lake Trip Crew",
    description: "Dates, deposits, and RSVPs",
    timezone: "America/New_York",
    raw: LAKE_TRIP,
  },
  {
    id: "room4b",
    name: "Room 4B Parents",
    description: "Bake sales and early dismissals",
    timezone: "America/Chicago",
    raw: ROOM_4B,
  },
];
