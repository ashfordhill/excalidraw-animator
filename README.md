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

Select something, press **G**, move/rotate/resize it, press **G** again. That's one animation; it starts at 0s. Play/pause/restart from the bar at the bottom; the ▲ opens the timeline, where clips can be dragged in time, renamed or deleted. Code lives in `packages/excalidraw/animation/`.
