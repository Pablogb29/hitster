# 🎵 Hitster Tabletop View

## Overview
The Tabletop View is a visual representation of the game designed for TV display during local multiplayer sessions. It shows all players around a virtual table with their cards and game state.

## Features

### 🎮 Visual Game Table
- **Circular Player Layout**: Players are positioned around a virtual table
- **Real-time Updates**: Syncs with game state via WebSocket
- **Turn Indicators**: Clear visual indication of whose turn it is
- **Score Display**: Shows each player's current score and card count

### 🎵 Hidden Card Display
- **Center Stage**: Current hidden card is displayed in the center of the table
- **Stage Indicators**: Shows if the card is ready, playing, or being placed
- **Visual Feedback**: Different colors and animations for different states

### 🏆 Game State
- **Player Status**: Shows each player's timeline cards (first 3 visible)
- **Turn Management**: Highlights the current player with a lightning bolt
- **Winner Display**: Crown icon for the winner
- **Game Phases**: Visual feedback for different game states

## Usage

### For Host
1. Start a game in the Lobby
2. Click "📺 Open Tabletop View" to open the full-screen tabletop
3. Display this view on your TV for all players to see
4. Players use their phones to join and play

### For Players
1. Scan the QR code or visit the join URL
2. Use your phone as your personal game interface
3. Watch the tabletop view on TV to see everyone's progress

## Technical Details

### Routes
- `/tabletop?code=ROOM_CODE&hostId=HOST_ID` - Full tabletop view
- Automatically opens when game starts from lobby
- Can be opened manually from host interface

### Real-time Sync
- WebSocket connection for live updates
- Shows current turn, hidden cards, and player states
- Updates automatically as game progresses

### Responsive Design
- Optimized for TV display (1920x1080+)
- Large, clear text and visual elements
- Dark theme for comfortable viewing

## Perfect for Local Multiplayer
- **One Device Host**: Host uses laptop/tablet to manage game
- **TV Display**: Tabletop view on big screen for everyone
- **Phone Players**: Each player uses their phone as their game interface
- **Social Gaming**: Everyone can see the game state and cheer each other on

## Visual Elements

### Player Seats
- **Current Player**: Green border with lightning bolt indicator
- **Winner**: Yellow ring with crown icon
- **Card Display**: Shows first 3 cards in player's timeline
- **Score Info**: Current score and total cards

### Hidden Card
- **Purple Theme**: Distinct color for hidden card area
- **Stage Indicators**: 
  - "Ready to play..." (incoming)
  - "Currently playing..." (active)
  - "Revealing..." (revealing)
  - "Incorrect placement" (failed)

### Table Design
- **Wooden Texture**: Amber/brown gradient for table surface
- **Circular Layout**: Players positioned around the table
- **Center Focus**: Hidden card prominently displayed in center
- **Status Updates**: Real-time game state information

This creates an immersive, social gaming experience perfect for parties and local multiplayer sessions!
