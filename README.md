# excalidraw-animator

because the existing slop coded ones are literally unusable

- [https://animator-excalidraw.vercel.app/](https://animator-excalidraw.vercel.app/)
  - No undo option, clicking the optiosn on the right for animation resulted in weird behavior. Couldn't animate my stick man to jump. 
- [https://app.excalimate.com/](https://app.excalimate.com/)
  - Awful 
- [https://github.com/dai-shi/excalidraw-animate](https://github.com/dai-shi/excalidraw-animate)
  - Can't really edit the animation, it gives you a default animation where every piece of the diagram fades in 1 by 1. Also can't edit your diagram.

- [https://www.excalimotion.com/](https://www.excalimotion.com/)
  - <img width="450" alt="image" src="https://github.com/user-attachments/assets/f6e21e3f-68bd-4422-a821-af98058dabd6" />

 lipstick on a pig smh

## Usage

`yarn && yarn start` → http://localhost:3001

- Select something, press **G** (or ● in the bottom bar), move/rotate/resize it, press **G** again. That's one clip; it starts at 0s.
- The bottom bar plays, pauses and restarts. The film icon opens the editor: clips on the left, timeline on the right. Drag a clip to move it in time; drag its edges to stretch or squeeze it.
- In the editor each clip's motion path shows as a dashed line. It's a normal Excalidraw line: bend it, add points, alt-drag to copy it, and drop its start point on another object to make that object follow it. Paths are hidden outside the editor and never exported.
- Undo covers clip edits too. Code lives in `packages/excalidraw/animation/`.
