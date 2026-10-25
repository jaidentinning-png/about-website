const cursorCanvas = document.getElementById("cursor-trail");
const cursorContext = cursorCanvas.getContext("2d");
const trailPoints = [];
let pointerX = window.innerWidth / 2;
let pointerY = window.innerHeight / 2;

function resizeCursorCanvas() {
    cursorCanvas.width = window.innerWidth * window.devicePixelRatio;
    cursorCanvas.height = window.innerHeight * window.devicePixelRatio;
    cursorContext.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
}

function drawCursorTrail() {
    cursorContext.clearRect(0, 0, window.innerWidth, window.innerHeight);

    for (let index = trailPoints.length - 1; index >= 0; index -= 1) {
        const point = trailPoints[index];
        point.life -= 0.018;
        point.radius *= 0.985;

        if (point.life <= 0 || point.radius <= 0.1) {
            trailPoints.splice(index, 1);
            continue;
        }

        cursorContext.beginPath();
        cursorContext.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
        cursorContext.fillStyle = `rgba(255, 255, 255, ${point.life})`;
        cursorContext.fill();
    }

    requestAnimationFrame(drawCursorTrail);
}

window.addEventListener("resize", resizeCursorCanvas);
window.addEventListener("pointermove", (event) => {
    pointerX = event.clientX;
    pointerY = event.clientY;
    const previous = trailPoints[trailPoints.length - 1];

    if (!previous || Math.hypot(pointerX - previous.x, pointerY - previous.y) > 4) {
        trailPoints.push({
            x: pointerX,
            y: pointerY,
            radius: 3.2,
            life: 0.85
        });
    }
});

resizeCursorCanvas();
drawCursorTrail();
